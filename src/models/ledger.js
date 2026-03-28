'use strict';

const mongoose = require('mongoose');
const Decimal = require('decimal.js');

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_TRANSITIONS = {
  PENDING: ['COMPLETED', 'FAILED'],
  COMPLETED: ['VOIDED'],
  FAILED: [],
  VOIDED: [],
};

const TRANSFER_DIRECTIONS = new Set([
  'ACCOUNT_TRANSFER_IN',
  'ACCOUNT_TRANSFER_OUT',
]);

const IMMUTABLE_FIELDS = new Set([
  'amount', 'userId', 'accountId', 'transactionType',
  'direction', 'parentTransactionId', 'category', 'replacesTransactionId',
  'transactedAt',
]);

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

    amount: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
      get: (v) => (v ? v.toString() : '0.00'),
      validate: {
        validator: function (v) {
          // Defensively handle the case where a raw JS number is passed instead of a Decimal128 object
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
    transferGroupId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      index: true,
    },

    idempotencyKey: {
      type: String,
      required: true,
      trim: true,
      minlength: [8, 'idempotencyKey must be at least 8 characters'],
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

    category: {
      type: String,
      required: true,
      trim: true,
      maxlength: [50, 'category cannot exceed 50 characters'],
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
    toJSON: { getters: true },
    toObject: { getters: true },
    optimisticConcurrency: true,
  }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

LedgerSchema.index({ accountId: 1, status: 1 });
LedgerSchema.index({ userId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { status: { $ne: 'FAILED' } } });
LedgerSchema.index({ accountId: 1, createdAt: -1 });
LedgerSchema.index({ userId: 1, _id: -1 });
LedgerSchema.index({ replacesTransactionId: 1 }, { sparse: true });

// Sparse index for reversal lookups by parent.
LedgerSchema.index({ parentTransactionId: 1 }, { sparse: true });

// FIX: Enforce one reversal per parent transaction at the database level.
// Prevents two concurrent requests with different idempotency keys from
// both reversing the same parent. The query-based alreadyReversed check
// in the controller is kept as an early exit for a better error message,
// but this index is the hard guarantee.
LedgerSchema.index(
  { parentTransactionId: 1, direction: 1 },
  {
    unique: true,
    sparse: true,
    partialFilterExpression: { direction: 'REVERSAL' },
    name: 'one_reversal_per_parent',
  }
);
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

  if (this.isNew) {
    if (TRANSFER_DIRECTIONS.has(this.direction) && !this.linkedAccountId) {
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
    // FIX: Use this.$session() so the read joins the active MongoDB
    // transaction. Without this, the findById runs outside the session
    // under read-committed isolation — it can see state from a concurrent
    // committed transaction that our current transaction hasn't observed,
    // making the transition validation causally inconsistent.
    const session = this.$session();

    const previous = await mongoose
      .model('Ledger')
      .findById(this._id, { status: 1 })
      .session(session)   // ← critical fix
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

  // ── Finalized entries cannot change ────────────────────────────────────────
  if (['COMPLETED', 'VOIDED', 'FAILED'].includes(this.status)) {
    throw new Error('Finalized ledger entries cannot be modified');
  }
});

// ─── Pre-update middleware ────────────────────────────────────────────────────

LedgerSchema.pre(['updateOne', 'findOneAndUpdate', 'updateMany'], async function () {
  this.setOptions({ runValidators: true });
  const update = this.getUpdate();
  const filter = this.getFilter();

  if (!Object.keys(update).some((k) => k.startsWith('$'))) {
    throw new Error('Document replacement is not permitted on ledger entries');
  }

  const targeted = new Set();
  for (const [op, payload] of Object.entries(update)) {
    if (op.startsWith('$') && payload && typeof payload === 'object') {
      for (const field of Object.keys(payload)) {
        targeted.add(field);
      }
    }
  }

  for (const field of IMMUTABLE_FIELDS) {
    if (targeted.has(field)) {
      throw new Error(`'${field}' cannot be modified after creation`);
    }
  }

  if (update.$set?.status) {
    const docs = await this.model.find(filter).session(this.getOptions().session ?? null);
    for (const doc of docs) {
      const allowed = VALID_TRANSITIONS[doc.status] ?? [];
      if (!allowed.includes(update.$set.status)) {
        throw new Error(
          `Invalid status transition: ${doc.status} → ${update.$set.status}`
        );
      }
    }
  }
});

// ─── Model ────────────────────────────────────────────────────────────────────

module.exports = mongoose.models.Ledger || mongoose.model('Ledger', LedgerSchema);