'use strict';

const mongoose = require('mongoose');
const Decimal = require('decimal.js');

// ─── State Machine ────────────────────────────────────────────────────────────
// Defines the only permitted status progressions.
// COMPLETED is terminal — no further transitions allowed.
const VALID_TRANSITIONS = {
  PENDING: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
};

// ─── Structural Rules ─────────────────────────────────────────────────────────
// Directions that require a counterparty account reference.
const DIRECTIONS_REQUIRING_LINKED_ACCOUNT = new Set([
  'ACCOUNT_TRANSFER_IN',
  'ACCOUNT_TRANSFER_OUT',
]);

// Fields that are write-once. Any attempt to modify these after creation
// is rejected at the middleware layer before reaching the database.
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

// ─── Direction → TransactionType Contract ─────────────────────────────────────
//
//  STANDARD             → INCOME | EXPENSE
//  GOAL_ALLOCATION      → EXPENSE
//  GOAL_DEALLOCATION    → INCOME
//  GOAL_COMPLETION      → EXPENSE
//  ACCOUNT_TRANSFER_OUT → TRANSFER
//  ACCOUNT_TRANSFER_IN  → TRANSFER
//  REVERSAL             → REVERSAL
//  RESERVED_IN          → RESERVE
//  RESERVED_OUT         → RESERVE
//
// Enforced at the controller layer via VALID_DIRECTION_TYPE_COMBINATIONS.
// Documented here as the schema-level source of truth.

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

    // Stored as Decimal128 to avoid IEEE 754 floating-point drift on monetary
    // values. Always call .toString() before arithmetic.
    //
    // WARNING: Mongoose getters do not fire inside MongoDB aggregation pipelines.
    // Wrap in { $toDouble: '$amount' } for any $group or $project stage.
    amount: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
      get: (v) => (v ? v.toString() : '0.00'),
      validate: {
        validator: (v) => {
          try {
            return new Decimal(v.toString()).greaterThanOrEqualTo('0.01');
          } catch {
            return false;
          }
        },
        message: 'amount must be at least 0.01',
      },
    },

    // Point-in-time balance snapshot written atomically with each ledger entry.
    // Supports balance-over-time queries without replaying the full ledger.
    // A negative value indicates a controller invariant violation.
    //
    // WARNING: Same aggregation caveat as amount — use { $toDouble: '$runningBalance' }.
    runningBalance: {
      type: mongoose.Schema.Types.Decimal128,
      default: null,
      get: (v) => (v ? v.toString() : null),
      validate: {
        validator: (v) => {
          if (v === null || v === undefined) return true;
          try {
            return new Decimal(v.toString()).greaterThanOrEqualTo('0');
          } catch {
            return false;
          }
        },
        message: 'runningBalance cannot be negative — likely a controller bug',
      },
    },

    // ── Classification ────────────────────────────────────────────────────────

    // Broad ledger category. Combined with direction to fully describe an entry.
    // See direction → transactionType contract above.
    transactionType: {
      type: String,
      enum: ['INCOME', 'EXPENSE', 'TRANSFER', 'REVERSAL', 'RESERVE'],
      required: true,
    },

    // Precise movement type. Drives balance delta computation in
    // computeBalanceDelta() and computeReversalDelta().
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
        'RESERVED_IN',
        'RESERVED_OUT',
      ],
      required: true,
      default: 'STANDARD',
    },

    // ── Linkage ───────────────────────────────────────────────────────────────

    // Counterparty account for ACCOUNT_TRANSFER_IN / ACCOUNT_TRANSFER_OUT.
    // Validated against DIRECTIONS_REQUIRING_LINKED_ACCOUNT in pre-save.
    linkedAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      default: null,
    },

    // Shared identifier written to both legs of a dual-account transfer.
    // Enables atomic detection of half-written transfers during idempotency
    // recovery. Immutable after creation.
    transferGroupId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      index: true,
    },

    // Back-reference from a REVERSAL entry to the entry it cancels.
    // Required when direction === 'REVERSAL'. Enforced in pre-save.
    // The one_reversal_per_parent index provides the DB-level uniqueness
    // guarantee — only one REVERSAL per parent is physically possible.
    // Immutable after creation.
    parentTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Ledger',
      default: null,
    },

    // ── Idempotency ───────────────────────────────────────────────────────────

    // Client-supplied deduplication key scoped to (userId, idempotencyKey).
    // Recommended format: '<action>-<uuidv4>' e.g. 'expense-a1b2c3d4...'
    // A FAILED entry releases the key so the client can retry with the same key.
    idempotencyKey: {
      type: String,
      required: true,
      trim: true,
      minlength: [8, 'idempotencyKey must be at least 8 characters'],
      maxlength: [128, 'idempotencyKey cannot exceed 128 characters'],
    },

    // ── Metadata ──────────────────────────────────────────────────────────────

    partyName: {
      type: String,
      trim: true,
      maxlength: [100, 'partyName cannot exceed 100 characters'],
    },

    // Normalised to Title Case on write via set() so aggregation $group buckets
    // remain consistent regardless of client casing ('food' → 'Food').
    category: {
      type: String,
      required: true,
      trim: true,
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

    // User-controlled timestamp — separate from createdAt (system clock).
    // Allows backdating e.g. logging yesterday's cash expense today.
    // Immutable after creation.
    transactedAt: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
    },

    // Terminal states (COMPLETED, VOIDED, FAILED) are enforced by the
    // state machine in pre-save. Transitions are one-way and irreversible.
    status: {
      type: String,
      enum: ['PENDING', 'COMPLETED', 'FAILED'],
      default: 'COMPLETED',
    },
  },
  {
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true },
    // Mongoose optimistic concurrency — increments __v on every save and
    // rejects stale writes with a VersionError, preventing lost updates
    // under concurrent modification.
    optimisticConcurrency: true,
  }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

// Account-level status filtering — used by account summary queries.
LedgerSchema.index({ accountId: 1, status: 1 });

// Idempotency enforcement. Partial filter excludes FAILED entries so a
// failed attempt can be safely retried with the same key.
// Concurrent retries race to the DB — the loser receives error.code 11000
// which the controller maps to a 409 response.
LedgerSchema.index(
  { userId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $ne: 'FAILED' } },
    name: 'unique_idempotency_per_user',
  }
);

// Recent transaction queries sorted by creation order.
LedgerSchema.index({ accountId: 1, createdAt: -1 });
LedgerSchema.index({ userId: 1, _id: -1 });

// Date-range filtering for history and analytics dashboard aggregations.
LedgerSchema.index({ userId: 1, transactedAt: -1 });

// Sparse index — only populated on REVERSAL entries.
LedgerSchema.index({ parentTransactionId: 1 }, { sparse: true });

// Hard uniqueness guarantee: physically allows only one REVERSAL per parent.
// The controller's alreadyReversed check provides an early exit with a
// descriptive error message — this index is the true enforcement layer.
LedgerSchema.index(
  { parentTransactionId: 1, direction: 1 },
  {
    unique: true,
    sparse: true,
    partialFilterExpression: { direction: 'REVERSAL' },
    name: 'one_reversal_per_parent',
  }
);

// ─── Pre-save Middleware ──────────────────────────────────────────────────────

LedgerSchema.pre('save', async function () {

  // ── New document validation ────────────────────────────────────────────────
  if (this.isNew) {
    if (DIRECTIONS_REQUIRING_LINKED_ACCOUNT.has(this.direction) && !this.linkedAccountId) {
      throw new Error(`direction '${this.direction}' requires a linkedAccountId`);
    }

    if (
      this.linkedAccountId &&
      this.accountId.toString() === this.linkedAccountId.toString()
    ) {
      throw new Error('accountId and linkedAccountId must reference different accounts');
    }

    if (this.direction === 'REVERSAL' && !this.parentTransactionId) {
      throw new Error('direction REVERSAL requires a parentTransactionId');
    }

    return;
  }

  // ── Immutability enforcement ───────────────────────────────────────────────
  for (const field of IMMUTABLE_FIELDS) {
    if (this.isModified(field)) {
      throw new Error(`'${field}' is immutable and cannot be changed after creation`);
    }
  }

  // ── Status transition enforcement ─────────────────────────────────────────
  if (this.isModified('status')) {
    const session = this.$session() ?? undefined;

    const previous = await mongoose
      .model('Ledger')
      .findById(this._id, { status: 1 })
      .session(session)
      .lean();

    if (!previous) {
      throw new Error('Ledger entry not found — status transition aborted');
    }

    const allowed = VALID_TRANSITIONS[previous.status] ?? [];
    if (!allowed.includes(this.status)) {
      throw new Error(
        `Invalid status transition: ${previous.status} → ${this.status}`
      );
    }

    return;
  }

  // ── Terminal state freeze ──────────────────────────────────────────────────
  if (['COMPLETED', 'FAILED'].includes(this.status)) {
    throw new Error('Finalized ledger entries are immutable');
  }
});

// ─── Pre-update Middleware ────────────────────────────────────────────────────

LedgerSchema.pre(['updateOne', 'findOneAndUpdate', 'updateMany'], async function () {
  this.setOptions({ runValidators: true });

  const update = this.getUpdate();
  const filter = this.getFilter();

  // Reject full document replacements — all mutations must use $ operators
  // to preserve field-level immutability guarantees.
  if (!Object.keys(update).some((k) => k.startsWith('$'))) {
    throw new Error('Document replacement is not permitted on ledger entries — use $ operators');
  }

  // Collect all fields targeted by this update operation.
  const targeted = new Set();
  for (const [op, payload] of Object.entries(update)) {
    if (op.startsWith('$') && payload && typeof payload === 'object') {
      for (const field of Object.keys(payload)) {
        targeted.add(field);
      }
    }
  }

  // Immutability guard — mirrors the pre-save check for update paths.
  for (const field of IMMUTABLE_FIELDS) {
    if (targeted.has(field)) {
      throw new Error(`'${field}' is immutable and cannot be modified after creation`);
    }
  }

  // Status transition guard — mirrors the pre-save state machine for update paths.
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