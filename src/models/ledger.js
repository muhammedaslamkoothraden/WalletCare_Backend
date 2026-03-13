const mongoose = require('mongoose');

/**
 * @desc    Immutable Financial Ledger Schema
 * @notes   Uses an append-only architecture where math (add/subtract) 
 * is implicitly determined by the transactionType and action.
 */
const LedgerSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    accountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      required: true,
      index: true
    },
    accountName: {
      type: String,
      required: true,
      trim: true
    },
    amount: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
      min: [0.01, 'Ledger amounts must be absolute positive values']
    },
    transactionType: {
      type: String,
      enum: ['INCOME', 'EXPENSE', 'TRANSFER', 'REVERSAL'], 
      required: true,
      uppercase: true
    },
    action: {
      type: String,
      enum: [
        'STANDARD',           // External money movement (In/Out)
        'GOAL_ALLOCATION',    // Reserve money from available to goal
        'GOAL_DEALLOCATION',  // Return reserved money to available
        'GOAL_COMPLETION',    // Spend reserved money for the goal
        'ACCOUNT_TRANSFER_IN',// Incoming from another wallet
        'ACCOUNT_TRANSFER_OUT',// Outgoing to another wallet
        'REVERSAL'            // Explicitly reverses a prior entry
      ],
      default: 'STANDARD',
      uppercase: true
    },
    linkedAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      default: null
    },
    idempotencyKey: {
      type: String,
      required: true,
      trim: true
    },
    
    parentTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Ledger',
      default: null
    },
    partyName: {
      type: String,
      trim: true 
    },
    category: {
      type: String,
      required: true,
      trim: true 
    },
    description: {
      type: String,
      trim: true
    },
    status: {
      type: String,
      enum: ['PENDING', 'COMPLETED', 'FAILED', 'VOIDED'],
      default: 'COMPLETED'
    }
  },
  {
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true }
  }
);

// Prevents duplicate processing via unique key per user [cite: 21]
LedgerSchema.index({ userId: 1, idempotencyKey: 1 }, { unique: true });

// Optimizes dashboard feeds and history lookups [cite: 21]
LedgerSchema.index({ accountId: 1, transactionType: 1, action: 1, createdAt: -1 });

// Supports quick lookups for cancellation/reversal history [cite: 21, 137]
LedgerSchema.index({ parentTransactionId: 1 }, { sparse: true });

// High-performance keyset pagination for history [cite: 21]
LedgerSchema.index({ userId: 1, _id: -1 });

// FinTech Immutability Guard: Prevents modification of completed records 
LedgerSchema.pre('save', function() {
  if (!this.isNew && this.status === 'COMPLETED') {
    const isVoiding = this.isModified('status') && this.status === 'VOIDED';
    
    if (!isVoiding) {
      throw new Error('Strict Compliance: Cannot modify a completed ledger entry.');
    }
  }
});

// Blocks standard Mongoose update methods from bypassing logic [cite: 136]
LedgerSchema.pre(['updateOne', 'findOneAndUpdate', 'updateMany'], function() {
  const update = this.getUpdate();
  if (update.$set && (update.$set.amount || update.$set.category)) {
     throw new Error('Strict Compliance: Protected ledger fields cannot be updated.');
  }
});

module.exports = mongoose.model('Ledger', LedgerSchema);