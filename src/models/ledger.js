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

const DIRECTIONS_REQUIRING_LINKED_ACCOUNT = new Set([
  'ACCOUNT_TRANSFER_IN',
  'ACCOUNT_TRANSFER_OUT',
]);

const IMMUTABLE_FIELDS = new Set([
  'amount',
  'userId',
  'accountId',
  'transactionType',
  'direction',
  'parentTransactionId',
  'category',
  'transactedAt',
  'transferGroupId',
]);

// Strict enum — prevents 'Food' and 'food' from creating separate $group
// buckets in aggregation. The set() normaliser handles case, enum handles
// validity. To add a new category update this array only.
// const VALID_CATEGORIES = [
//   'Food',
//   'Transport',
//   'Shopping',
//   'Health',
//   'Entertainment',
//   'Education',
//   'Utilities',
//   'Rent',
//   'Salary',
//   'Investment',
//   'Transfer',
//   'Goals',
//   'Other',
// ];

// ─── Schema ───────────────────────────────────────────────────────────────────

const LedgerSchema = new mongoose.Schema(
  {
    // ── Ownership ─────────────────────────────────────────────────────────────
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

    // ── Financials ────────────────────────────────────────────────────────────

    // ⚠️ AGGREGATION NOTE:
    // Getters (v.toString()) apply when reading via JS (doc.amount).
    // They do NOT fire inside MongoDB aggregation pipelines.
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
    // Enables balance-over-time charts without re-summing all ledger entries.
    // ⚠️ Same aggregation note — use { $toDouble: '$runningBalance' }
    // A negative value here means a controller bug — guard below catches it.
    runningBalance: {
      type: mongoose.Schema.Types.Decimal128,
      default: null,
      get: (v) => (v ? v.toString() : null),
      validate: {
        validator: function (v) {
          if (v === null || v === undefined) return true;
          try {
            return new Decimal(v.toString()).greaterThanOrEqualTo('0');
          } catch {
            return false;
          }
        },
        message: 'runningBalance cannot be negative',
      },
    },

    // ── Classification ────────────────────────────────────────────────────────

    transactionType: {
      type: String,
      enum: ['INCOME', 'EXPENSE', 'TRANSFER', 'REVERSAL'],
      required: true,
    },

    // Valid direction + transactionType combinations:
    //
    //  STANDARD             → INCOME | EXPENSE
    //  GOAL_ALLOCATION      → EXPENSE
    //  GOAL_DEALLOCATION    → INCOME
    //  GOAL_COMPLETION      → EXPENSE
    //  ACCOUNT_TRANSFER_OUT → TRANSFER
    //  ACCOUNT_TRANSFER_IN  → TRANSFER
    //  REVERSAL             → REVERSAL
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
      ],
      required: true,
      default: 'STANDARD',
    },

    // ── Linkage ───────────────────────────────────────────────────────────────

    // Required when direction is ACCOUNT_TRANSFER_IN or ACCOUNT_TRANSFER_OUT.
    linkedAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      default: null,
    },

    // Groups the OUT and IN ledger entries of a single account transfer.
    // Same ObjectId is set on both legs at creation time.
    // Used to detect half-written transfers during idempotency recovery.
    // Immutable after creation — see IMMUTABLE_FIELDS.
    transferGroupId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      index: true,
    },

    // Links a REVERSAL entry back to the original entry it cancels.
    // Required when transactionType === 'REVERSAL'.
    // Immutable after creation — see IMMUTABLE_FIELDS.
    parentTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Ledger',
      default: null,
    },

    // ── Idempotency ───────────────────────────────────────────────────────────

    // Unique per (userId, idempotencyKey) — see index below.
    // Recommended format: '<action>-<uuid>' e.g. 'reversal-abc123xyz'
    idempotencyKey: {
      type: String,
      required: true,
      trim: true,
      minlength: [8,   'idempotencyKey must be at least 8 characters'],
      maxlength: [128, 'idempotencyKey cannot exceed 128 characters'],
    },

    // ── Metadata ──────────────────────────────────────────────────────────────

    partyName: {
      type: String,
      trim: true,
      maxlength: [100, 'partyName cannot exceed 100 characters'],
    },

    // set() normalises to Title Case first so 'food' → 'Food' before
    // enum validation fires. This means 'food' passes, 'xyz' is rejected.
    category: {
      type: String,
      required: true,
      trim: true,
      // enum: {
      //   values: VALID_CATEGORIES,
      //   message:
      //     "Category '{VALUE}' is not valid. Must be one of: " +
      //     VALID_CATEGORIES.join(', '),
      // },
      set: (v) => {
        if (!v) return v;
        return v.charAt(0).toUpperCase() + v.slice(1).toLowerCase();
      },
    },

    description: {
      type: String,
      trim: true,
      maxlength: [255, 'description cannot exceed 255 characters'],
    },

    // User-controlled date — separate from createdAt (system timestamp).
    // Allows backdating e.g. logging a cash expense from yesterday.
    // Immutable after creation — see IMMUTABLE_FIELDS.
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
    timestamps: true,          // adds createdAt, updatedAt automatically
    toJSON:   { getters: true },
    toObject: { getters: true },
    optimisticConcurrency: true, // prevents lost-update race on concurrent saves
  }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

LedgerSchema.index({ accountId: 1, status: 1 });

// Unique per (userId, idempotencyKey) — excludes FAILED so a failed attempt
// can be retried with the same key. Concurrent retries of a failed key race
// to the DB; one wins the insert, the other gets a 11000 duplicate key error
// which the controller handles via the error.code === 11000 path.
LedgerSchema.index(
  { userId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { status: { $ne: 'FAILED' } } }
);

LedgerSchema.index({ accountId: 1, createdAt: -1 });
LedgerSchema.index({ userId: 1, _id: -1 });

// Supports date-range filtering in getHistory and analytics dashboard queries.
LedgerSchema.index({ userId: 1, transactedAt: -1 });

// Sparse — only populated on REVERSAL entries.
LedgerSchema.index({ parentTransactionId: 1 }, { sparse: true });

// DB-level hard guarantee: only one REVERSAL allowed per parent transaction.
// The controller's alreadyReversed check is an early exit for a better error
// message — this index is the true enforcement layer.
LedgerSchema.index(
  { parentTransactionId: 1, direction: 1 },
  {
    unique: true,
    sparse: true,
    partialFilterExpression: { direction: 'REVERSAL' },
    name: 'one_reversal_per_parent',
  }
);

// ─── Pre-save middleware ──────────────────────────────────────────────────────

LedgerSchema.pre('save', async function () {

  // ── New entry validation ───────────────────────────────────────────────────
  if (this.isNew) {

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
      throw new Error(
        `Invalid status transition: ${previous.status} → ${this.status}`
      );
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

  // Block full document replacement — entries must only be patched via
  // $ operators to preserve immutability guarantees.
  if (!Object.keys(update).some((k) => k.startsWith('$'))) {
    throw new Error('Document replacement is not permitted on ledger entries');
  }

  // Collect all fields targeted by this update.
  const targeted = new Set();
  for (const [op, payload] of Object.entries(update)) {
    if (op.startsWith('$') && payload && typeof payload === 'object') {
      for (const field of Object.keys(payload)) {
        targeted.add(field);
      }
    }
  }

  // Immutability guard.
  for (const field of IMMUTABLE_FIELDS) {
    if (targeted.has(field)) {
      throw new Error(`'${field}' cannot be modified after creation`);
    }
  }

  // Status transition guard.
  if (update.$set?.status) {
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