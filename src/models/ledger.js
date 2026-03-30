'use strict';

const mongoose = require('mongoose');
const Decimal = require('decimal.js');

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_TRANSITIONS = {
  PENDING:   ['COMPLETED', 'FAILED'],
  COMPLETED: ['VOIDED'],
  FAILED:    [],
  VOIDED:    [],
};

// FIX: Renamed from TRANSFER_DIRECTIONS — now covers all directions that
// require linkedAccountId, not just transfer legs.
const DIRECTIONS_REQUIRING_LINKED_ACCOUNT = new Set([
  'ACCOUNT_TRANSFER_IN',
  'ACCOUNT_TRANSFER_OUT',
]);

// FIX: Added transferGroupId — it is structural metadata set at creation
// and must never change. Changing it would break the half-write detection
// logic in the transfer service idempotency recovery path.
const IMMUTABLE_FIELDS = new Set([
  'amount',
  'userId',
  'accountId',
  'transactionType',
  'direction',
  'parentTransactionId',
  'category',
  'replacesTransactionId',
  'transactedAt',
  'transferGroupId',
]);

// ─── Valid Categories ─────────────────────────────────────────────────────────
// FIX: Locked down as an explicit enum to prevent silent analytics breakage.
// Free-text category caused 'Food' and 'food' to produce separate $group
// buckets in aggregation. The set() normalizer alone was not sufficient —
// 'XYZ' would still be stored as a valid category.
// Add new values here as product requirements evolve.
const VALID_CATEGORIES = [
  'Food',
  'Transport',
  'Shopping',
  'Health',
  'Entertainment',
  'Education',
  'Utilities',
  'Rent',
  'Salary',
  'Investment',
  'Transfer',
  'Goals',
  'Other',
];

// ─── Schema ───────────────────────────────────────────────────────────────────

const LedgerSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    accountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      required: true,
    },
    goalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Goal',
      default: null,
      index: true,
    },

    // ⚠️ AGGREGATION NOTE:
    // The getter (v.toString()) applies when reading via JS (doc.amount).
    // It does NOT fire inside MongoDB aggregation pipelines.
    // Always wrap in aggregation: { $toDouble: '$amount' }
    amount: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
      get: (v) => (v ? v.toString() : '0.00'),
      validate: {
        validator: function (v) {
          try {
            return new Decimal(v.toString()).greaterThanOrEqualTo('0.01');
          } catch {
            return false;
          }
        },
        message: 'Amount must be at least 0.01',
      },
    },

    // Balance snapshot at the moment this entry was written.
    // Set by the transaction controller after computing the new account balance.
    // Enables balance-over-time charts without re-summing all ledger entries.
    // ⚠️ Same aggregation note as amount — use { $toDouble: '$runningBalance' }
    //
    // FIX: Added non-negative validator. A negative running balance indicates
    // a controller bug (Account schema guards against negative balances).
    // Catching it here provides an additional safety net.
    runningBalance: {
      type: mongoose.Schema.Types.Decimal128,
      default: null,
      get: (v) => (v ? v.toString() : null),
      validate: {
        validator: function (v) {
          if (v === null || v === undefined) return true; // null is allowed (unset)
          try {
            return new Decimal(v.toString()).greaterThanOrEqualTo('0');
          } catch {
            return false;
          }
        },
        message: 'runningBalance cannot be negative',
      },
    },

    transactionType: {
      type: String,
      enum: ['INCOME', 'EXPENSE', 'TRANSFER', 'REVERSAL'],
      required: true,
    },

    direction: {
      type: String,
      enum: [
        'STANDARD',
        'GOAL_ALLOCATION',
        'GOAL_DEALLOCATION',
        'GOAL_COMPLETION',
        'ACCOUNT_TRANSFER_IN',
        'ACCOUNT_TRANSFER_OUT',
        'REVERSAL',
        'EDIT_REPLACEMENT',
      ],
      required: true,
      default: 'STANDARD',
    },

    linkedAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      default: null,
    },

    // Groups the OUT and IN ledger entries of a single transfer.
    // Used to detect and surface half-written transfers during
    // idempotency recovery. Set to the same ObjectId on both legs.
    // Immutable after creation — see IMMUTABLE_FIELDS above.
    transferGroupId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      index: true,
    },

    idempotencyKey: {
      type: String,
      required: true,
      trim: true,
      minlength: [8,   'idempotencyKey must be at least 8 characters'],
      maxlength: [128, 'idempotencyKey cannot exceed 128 characters'],
    },

    parentTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Ledger',
      default: null,
    },
    replacesTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Ledger',
      default: null,
    },

    partyName: {
      type: String,
      trim: true,
      maxlength: [100, 'partyName cannot exceed 100 characters'],
    },

    // FIX: Now enforced as both a normalizing setter AND a strict enum.
    // The setter alone was insufficient — any arbitrary string like 'XYZ'
    // would pass through normalized but still be stored as an invalid category,
    // causing silent analytics breakage in $group aggregations.
    // To add a new category, update both VALID_CATEGORIES and this enum.
    category: {
      type: String,
      required: true,
      trim: true,
      enum: {
        values: VALID_CATEGORIES,
        message: 'Category \'{VALUE}\' is not valid. Must be one of: ' + VALID_CATEGORIES.join(', '),
      },
      set: (v) => {
        if (!v) return v;
        // Normalise to Title Case before enum validation fires.
        return v.charAt(0).toUpperCase() + v.slice(1).toLowerCase();
      },
    },

    description: {
      type: String,
      trim: true,
      maxlength: [255, 'description cannot exceed 255 characters'],
    },

    transactedAt: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
    },

    status: {
      type: String,
      enum: ['PENDING', 'COMPLETED', 'FAILED', 'VOIDED'],
      default: 'COMPLETED',
    },
  },
  {
    timestamps: true,
    toJSON:   { getters: true },
    toObject: { getters: true },
    optimisticConcurrency: true,
  }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

LedgerSchema.index({ accountId: 1, status: 1 });

// Unique per (userId, idempotencyKey) — excludes FAILED entries so that a
// failed attempt can be retried with the same key.
// NOTE: two concurrent retries of a failed key can race past the controller's
// idempotency check simultaneously. One will win the insert; the other gets
// a 11000 duplicate key error. The transfer service catch block handles this
// correctly via the error.code === 11000 path.
LedgerSchema.index(
  { userId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { status: { $ne: 'FAILED' } } }
);

LedgerSchema.index({ accountId: 1, createdAt: -1 });
LedgerSchema.index({ userId: 1, _id: -1 });

// FIX: Added compound index on (userId, transactedAt) to support date-range
// filtering in getHistory and analytics dashboard queries.
// Without this, queries filtering by userId + transactedAt range fall back
// to a collection scan on transactedAt for a given user — unacceptable at scale.
LedgerSchema.index({ userId: 1, transactedAt: -1 });

// Sparse index for reversal lookups by parent.
LedgerSchema.index({ parentTransactionId: 1 }, { sparse: true });

// DB-level guard: only one REVERSAL allowed per parent transaction.
// Prevents two concurrent requests with different idempotency keys from
// both reversing the same parent. The controller's alreadyReversed check
// is kept as an early exit for a better error message, but this index
// is the hard guarantee.
LedgerSchema.index(
  { parentTransactionId: 1, direction: 1 },
  {
    unique: true,
    sparse: true,
    partialFilterExpression: { direction: 'REVERSAL' },
    name: 'one_reversal_per_parent',
  }
);

// FIX: Removed the redundant { replacesTransactionId: 1, sparse: true } index
// that existed before this composite index. It was a subset of this index
// and created unnecessary write overhead on every ledger insert.
LedgerSchema.index(
  { replacesTransactionId: 1, direction: 1 },
  {
    unique: true,
    sparse: true,
    partialFilterExpression: { direction: 'EDIT_REPLACEMENT' },
    name: 'one_edit_per_original',
  }
);

// ─── Pre-save middleware ──────────────────────────────────────────────────────

LedgerSchema.pre('save', async function () {

  // ── New entry validation ───────────────────────────────────────────────────
  if (this.isNew) {

    // FIX: Uses DIRECTIONS_REQUIRING_LINKED_ACCOUNT (renamed from TRANSFER_DIRECTIONS)
    // to be explicit that this check is about linkedAccountId presence,
    // not just about whether the direction is a transfer leg.
    if (DIRECTIONS_REQUIRING_LINKED_ACCOUNT.has(this.direction) && !this.linkedAccountId) {
      throw new Error(`direction '${this.direction}' requires linkedAccountId`);
    }

    if (
      this.linkedAccountId &&
      this.accountId.toString() === this.linkedAccountId.toString()
    ) {
      throw new Error('accountId and linkedAccountId must not be the same account');
    }

    if (this.transactionType === 'REVERSAL' && !this.parentTransactionId) {
      throw new Error('REVERSAL transactions must reference a parentTransactionId');
    }

    if (this.direction === 'EDIT_REPLACEMENT' && !this.replacesTransactionId) {
      throw new Error('EDIT_REPLACEMENT transactions must reference a replacesTransactionId');
    }

    // NOTE: The EDIT_REPLACEMENT + replacesTransactionId validation above only
    // runs for new entries (pre-save on isNew). This is intentional — ledger
    // entries are immutable after creation, so an EDIT_REPLACEMENT can never
    // lose its replacesTransactionId post-creation. The gap is by design.

    return;
  }

  // ── Immutability ───────────────────────────────────────────────────────────
  for (const field of IMMUTABLE_FIELDS) {
    if (this.isModified(field)) {
      throw new Error(`'${field}' cannot be changed after creation`);
    }
  }

  // ── Status transition ──────────────────────────────────────────────────────
  if (this.isModified('status')) {
    // FIX: this.$session() can return null on a document not enrolled in a
    // session. Passing null explicitly to .session() in Mongoose clears the
    // session (different from undefined which is a no-op). Use ?? undefined
    // to ensure we never pass null.
    const session = this.$session() ?? undefined;

    const previous = await mongoose
      .model('Ledger')
      .findById(this._id, { status: 1 })
      .session(session)
      .lean();

    if (!previous) {
      throw new Error('Ledger entry not found — cannot validate status transition');
    }

    const allowed = VALID_TRANSITIONS[previous.status] ?? [];
    if (!allowed.includes(this.status)) {
      throw new Error(`Invalid status transition: ${previous.status} → ${this.status}`);
    }

    return;
  }

  // ── Finalized entries are frozen ───────────────────────────────────────────
  if (['COMPLETED', 'VOIDED', 'FAILED'].includes(this.status)) {
    throw new Error('Finalized ledger entries cannot be modified');
  }
});

// ─── Pre-update middleware ────────────────────────────────────────────────────

LedgerSchema.pre(['updateOne', 'findOneAndUpdate', 'updateMany'], async function () {
  this.setOptions({ runValidators: true });

  const update = this.getUpdate();
  const filter = this.getFilter();

  // Block full document replacement — ledger entries must only be patched
  // via $ operators to preserve immutability guarantees.
  if (!Object.keys(update).some((k) => k.startsWith('$'))) {
    throw new Error('Document replacement is not permitted on ledger entries');
  }

  // Collect all fields targeted by this update
  const targeted = new Set();
  for (const [op, payload] of Object.entries(update)) {
    if (op.startsWith('$') && payload && typeof payload === 'object') {
      for (const field of Object.keys(payload)) {
        targeted.add(field);
      }
    }
  }

  // Immutability guard
  for (const field of IMMUTABLE_FIELDS) {
    if (targeted.has(field)) {
      throw new Error(`'${field}' cannot be modified after creation`);
    }
  }

  // Status transition guard
  if (update.$set?.status) {
    // FIX: Replaced model.find(filter) with findOne + lean() — same N+1
    // problem as Account.js. A broad filter could load many documents just
    // to validate one status transition.
    //
    // FIX: session is passed as `?? undefined` — passing null explicitly to
    // .session() in some Mongoose versions clears the session rather than
    // being a no-op.
    const session = this.getOptions()?.session ?? undefined;

    const doc = await this.model
      .findOne(filter)
      .lean()
      .session(session);

    if (!doc) return;

    const allowed = VALID_TRANSITIONS[doc.status] ?? [];
    if (!allowed.includes(update.$set.status)) {
      throw new Error(
        `Invalid status transition: ${doc.status} → ${update.$set.status}`
      );
    }
  }
});

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = mongoose.models.Ledger || mongoose.model('Ledger', LedgerSchema);