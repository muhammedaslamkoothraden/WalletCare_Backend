const mongoose = require('mongoose');

/**
 * Ledger Schema - The authoritative source of truth for WalletCare.
 * Every movement of money must result in a Ledger entry.
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
    // Using Decimal128 for absolute financial precision
    amount: {
      type: mongoose.Schema.Types.Decimal128,
      required: true
    },
    transactionType: {
      type: String,
      enum: ['INCOME', 'EXPENSE', 'TRANSFER', 'GOAL_ALLOCATION', 'GOAL_DEALLOCATION'],
      required: true,
      uppercase: true
    },
    // CREDIT adds to balance, DEBIT subtracts, INTERNAL stays within the account
    direction: {
      type: String,
      enum: ['CREDIT', 'DEBIT', 'INTERNAL'],
      required: true,
      uppercase: true
    },
    // Crucial for Fintech: Prevents duplicate charges on network retries
    idempotencyKey: {
      type: String,
      required: true,
      trim: true
    },
    category: {
      type: String,
      required: true,
      trim: true // e.g., 'Food', 'Salary', 'Rent'
    },
    description: {
      type: String,
      trim: true
    },
    status: {
      type: String,
      enum: ['PENDING', 'COMPLETED', 'FAILED'],
      default: 'COMPLETED'
    }
  },
  {
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true }
  }
);

// --- INDEXES ---
// 1. Unique constraint: A user cannot submit the same idempotency key twice.
LedgerSchema.index({ userId: 1, idempotencyKey: 1 }, { unique: true });

// 2. Query optimization: For showing the user's transaction history.
LedgerSchema.index({ accountId: 1, createdAt: -1 });

module.exports = mongoose.model('Ledger', LedgerSchema);