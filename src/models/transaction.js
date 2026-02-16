const mongoose = require('mongoose');

const TransactionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },

    walletId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Wallet',
      required: true,
      index: true
    },

    amount: {
      type: Number,
      required: true,
      min: [0, 'Transaction amount must be positive']
    },

    type: {
      type: String,
      enum: ['income', 'expense', 'transfer'],
      required: true
    },

    category: {
      type: String,
      required: true,
      trim: true
      // e.g., 'Salary', 'Food', 'Rent'
    },

    description: {
      type: String,
      trim: true
    },

    date: {
      type: Date,
      default: Date.now
    }
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

/**
 * Indexes for faster queries
 * 1. walletId + date descending → recent transactions per wallet
 * 2. userId + date descending → recent transactions per user
 */
TransactionSchema.index({ walletId: 1, date: -1 });
TransactionSchema.index({ userId: 1, date: -1 });

module.exports = mongoose.model('Transaction', TransactionSchema);
