const mongoose = require('mongoose');

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
    amount: {
      type: mongoose.Schema.Types.Decimal128,
      required: true
    },
    transactionType: {
      type: String,
      // Added 'REVERSAL' to identify correction entries
      enum: ['INCOME', 'EXPENSE', 'TRANSFER', 'REVERSAL'], 
      required: true,
      uppercase: true
    },
    direction: {
      type: String,
      // Added 'REVERSAL' to keep direction logic clean during audits
      enum: ['NORMAL', 'CREDIT', 'DEBIT', 'GOAL_ALLOCATION', 'GOAL_DEALLOCATION', 'REVERSAL'],
      required: true,
      uppercase: true
    },
    idempotencyKey: {
      type: String,
      required: true,
      trim: true
    },
    // NEW: Link back to the original transaction being reversed
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
      // Added 'VOIDED' to mark the original transaction as cancelled
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

// Indexes
LedgerSchema.index({ userId: 1, idempotencyKey: 1 }, { unique: true });
LedgerSchema.index({ accountId: 1, createdAt: -1 });
// Added index for parent lookups (useful for finding the reversal entry of an original tx)
LedgerSchema.index({ parentTransactionId: 1 }, { sparse: true });

module.exports = mongoose.model('Ledger', LedgerSchema);