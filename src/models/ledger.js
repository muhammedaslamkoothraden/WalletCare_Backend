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
      enum: ['INCOME', 'EXPENSE', 'TRANSFER'], 
      required: true,
      uppercase: true
    },
    /**
     * NORMAL: Standard income/expense (Yours to keep/spend)
     * CREDIT: From a Creditor (You owe this back)
     * DEBIT: To a Debtor (They owe you back)
     * GOAL_ALLOCATION: Move Available -> Reserved
     * GOAL_DEALLOCATION: Move Reserved -> Available
     */
    direction: {
      type: String,
      enum: ['NORMAL', 'CREDIT', 'DEBIT', 'GOAL_ALLOCATION', 'GOAL_DEALLOCATION'],
      required: true,
      uppercase: true
    },
    idempotencyKey: {
      type: String,
      required: true,
      trim: true
    },
    partyName: {
      type: String,
      trim: true // Name of the Creditor/Debtor if applicable
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

// Indexes for performance and safety
LedgerSchema.index({ userId: 1, idempotencyKey: 1 }, { unique: true });
LedgerSchema.index({ accountId: 1, createdAt: -1 });

module.exports = mongoose.model('Ledger', LedgerSchema);