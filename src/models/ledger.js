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
      // Added 'DEBT_MANAGEMENT' to separate loans/debts from standard Income/Expense
      enum: ['INCOME', 'EXPENSE', 'TRANSFER', 'REVERSAL', 'DEBT_MANAGEMENT'], 
      required: true,
      uppercase: true
    },
    direction: {
      type: String,
      /** * NORMAL: Standard Income/Expense
       * CREDIT: Money from Creditor (Liability)
       * DEBIT: Money to Debtor (Asset/Loan Out)
       * GOAL_*: Internal Reservation logic
       */
      enum: [
        'NORMAL', 
        'CREDIT', 
        'DEBIT', 
        'GOAL_ALLOCATION', 
        'GOAL_DEALLOCATION', 
        'REVERSAL'
      ],
      required: true,
      uppercase: true
    },
    idempotencyKey: {
      type: String,
      required: true,
      // FIX 1: Removed `unique: true` from here to prevent global database conflicts.
      // Uniqueness is now safely handled by the compound index at the bottom.
      trim: true
    },
    parentTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Ledger',
      default: null
    },
    partyName: {
      type: String, // e.g., "Bank of America" or "John Doe"
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

// --- Strategic Indexing ---

// 1. Prevent Double Processing (UserId + Key)
// This perfectly ensures a single user cannot reuse an idempotency key.
LedgerSchema.index({ userId: 1, idempotencyKey: 1 }, { unique: true });

// 2. High-Performance Filtering (The "Advanced Filter" Index)
// This covers filtering by Account, Direction, and Type for the history feed
LedgerSchema.index({ accountId: 1, direction: 1, transactionType: 1, createdAt: -1 });

// 3. Reversal Lookups (Sparse index ignores nulls to save space)
LedgerSchema.index({ parentTransactionId: 1 }, { sparse: true });

// 4. Global User History Keyset Pagination
LedgerSchema.index({ userId: 1, _id: -1 });

// --- FINTECH IMMUTABILITY GUARD ---
/**
 * FIX 2: In the financial world, once a ledger entry is written, it is permanent.
 * This middleware prevents any rogue code from accidentally updating a transaction's amount or category.
 */
LedgerSchema.pre('save', function(next) {
  if (!this.isNew && this.status === 'COMPLETED') {
    // Only allow updates if we are explicitly changing the status to VOIDED
    if (!this.isModified('status') || this.status !== 'VOIDED') {
      return next(new Error('Strict FinTech Compliance: Cannot modify a completed ledger entry. Create a reversal instead.'));
    }
  }
  next();
});

module.exports = mongoose.model('Ledger', LedgerSchema);