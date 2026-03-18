'use strict';

const mongoose = require('mongoose');
const Decimal  = require('decimal.js');

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_TRANSITIONS = {
  PENDING:   ['COMPLETED', 'FAILED'],
  COMPLETED: ['VOIDED'],
  FAILED:    [],
  VOIDED:    [],
};

const TRANSFER_DIRECTIONS = new Set([
  'ACCOUNT_TRANSFER_IN',
  'ACCOUNT_TRANSFER_OUT',
]);

// Financial fields that can never change after creation.
// description and partyName are excluded — they may be corrected
// on PENDING entries before finalization.
const IMMUTABLE_FIELDS = new Set([
  'amount', 'userId', 'accountId', 'transactionType',
  'direction', 'idempotencyKey', 'parentTransactionId', 'category',
]);

// ─── Schema ───────────────────────────────────────────────────────────────────

const LedgerSchema = new mongoose.Schema(
  {
    userId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: true,
      index:    true,
    },
    accountId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Account',
      required: true,
    },
    amount: {
      type:     mongoose.Schema.Types.Decimal128,
      required: true,
      get:      (v) => (v ? v.toString() : '0.00'),
      validate: {
        // Mongoose's built-in min silently ignores Decimal128 —
        // a manual validator with try/catch is required
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
    transactionType: {
      type:     String,
      enum:     ['INCOME', 'EXPENSE', 'TRANSFER', 'REVERSAL'],
      required: true,
    },
    direction: {
      type:     String,
      enum:     [
        'STANDARD',
        'GOAL_ALLOCATION',
        'GOAL_DEALLOCATION',
        'GOAL_COMPLETION',
        'ACCOUNT_TRANSFER_IN',
        'ACCOUNT_TRANSFER_OUT',
        'REVERSAL',
      ],
      required: true,
      default:  'STANDARD',
    },
    linkedAccountId: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'Account',
      default: null,
    },
    idempotencyKey: {
      type:      String,
      required:  true,
      trim:      true,
      minlength: [8,   'idempotencyKey must be at least 8 characters'],
      maxlength: [128, 'idempotencyKey cannot exceed 128 characters'],
    },
    parentTransactionId: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'Ledger',
      default: null,
    },
    partyName: {
      type:      String,
      trim:      true,
      maxlength: [100, 'partyName cannot exceed 100 characters'],
    },
    category: {
      type:      String,
      required:  true,
      trim:      true,
      maxlength: [50, 'category cannot exceed 50 characters'],
    },
    description: {
      type:      String,
      trim:      true,
      maxlength: [255, 'description cannot exceed 255 characters'],
    },
    status: {
      type:    String,
      enum:    ['PENDING', 'COMPLETED', 'FAILED', 'VOIDED'],
      default: 'COMPLETED',
    },
  },
  {
    timestamps: true,
    toJSON:     { getters: true },
    toObject:   { getters: true },
    // Mongoose increments __v on every save and includes it in the WHERE
    // clause — if another request saved first, this throws a VersionError.
    // This is detect-and-reject concurrency, not a lock. True atomicity
    // across a read + save requires a MongoDB session at the service layer.
    optimisticConcurrency: true,
  }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

LedgerSchema.index({ userId: 1, idempotencyKey: 1 }, { unique: true });
LedgerSchema.index({ accountId: 1, transactionType: 1, direction: 1, createdAt: -1 });
LedgerSchema.index({ parentTransactionId: 1 }, { sparse: true });
LedgerSchema.index({ userId: 1, _id: -1 });

// ─── Pre-save middleware ──────────────────────────────────────────────────────

LedgerSchema.pre('save', async function () {

  // ── New document: cross-field validation ──────────────────────────────────
  if (this.isNew) {
    if (TRANSFER_DIRECTIONS.has(this.direction) && !this.linkedAccountId) {
      throw new Error(`direction '${this.direction}' requires linkedAccountId`);
    }

    // Compare as strings — ObjectId === ObjectId is always false
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

  // ── Existing document: immutability ───────────────────────────────────────
  for (const field of IMMUTABLE_FIELDS) {
    if (this.isModified(field)) {
      throw new Error(`'${field}' cannot be changed after creation`);
    }
  }

  // ── Existing document: state machine ──────────────────────────────────────
  if (this.isModified('status')) {
    // Fetch previous status — optimisticConcurrency will reject the save if
    // __v has advanced since we loaded this document, closing the race window
    const previous = await mongoose
      .model('Ledger')
      .findById(this._id, { status: 1 })
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

  // ── Block all other changes to finalized entries ───────────────────────────
  if (['COMPLETED', 'VOIDED', 'FAILED'].includes(this.status)) {
    throw new Error('Finalized ledger entries cannot be modified');
  }
});

// ─── Pre-update middleware ────────────────────────────────────────────────────

LedgerSchema.pre(['updateOne', 'findOneAndUpdate', 'updateMany'], function () {
  const update = this.getUpdate();
  const filter = this.getFilter();

  // Block full document replacement — overwrites all fields including immutable ones
  if (!Object.keys(update).some((k) => k.startsWith('$'))) {
    throw new Error('Document replacement is not permitted on ledger entries');
  }

  // Collect all field names targeted by any update operator.
  // Handles nested array operator syntax: $push: { field: { $each: [...] } }
  const targeted = new Set();
  for (const [op, payload] of Object.entries(update)) {
    if (op.startsWith('$') && payload && typeof payload === 'object') {
      for (const field of Object.keys(payload)) {
        targeted.add(field);
      }
    }
  }

  // Block modifications to immutable financial fields
  for (const field of IMMUTABLE_FIELDS) {
    if (targeted.has(field)) {
      throw new Error(`'${field}' cannot be modified after creation`);
    }
  }

  // State machine enforcement for direct status updates.
  // Caller must include current status in filter — MongoDB's match condition
  // acts as the atomic check. If the DB status differs, zero docs are updated.
  // ⚠️  Service layer must check modifiedCount === 0 and treat it as a conflict.
  if (update.$set?.status) {
    if (!filter.status) {
      throw new Error(
        'Status updates must include current status in the filter ' +
        'for atomic transition safety — e.g. { _id, status: "COMPLETED" }'
      );
    }

    const allowed = VALID_TRANSITIONS[filter.status] ?? [];
    if (!allowed.includes(update.$set.status)) {
      throw new Error(
        `Invalid status transition: ${filter.status} → ${update.$set.status}`
      );
    }
  }
});

// ─── Model ────────────────────────────────────────────────────────────────────

module.exports = mongoose.models.Ledger || mongoose.model('Ledger', LedgerSchema);