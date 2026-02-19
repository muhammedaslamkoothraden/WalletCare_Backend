const mongoose = require('mongoose');

const WalletSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true
    },

    availableBalance: {
      type: Number,
      default: 0,
      min: [0, 'Available balance cannot be negative']
    },

    savingsBalance: {
      type: Number,
      default: 0,
      min: [0, 'Savings balance cannot be negative']
    },

    currency: {
      type: String,
      default: 'INR',
      uppercase: true,
      trim: true
    }
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

/**
 * Virtual field: total balance
 * Not stored in DB, computed dynamically
 */
WalletSchema.virtual('totalBalance').get(function () {
  return this.availableBalance + this.savingsBalance;
});

module.exports = mongoose.model('Wallet', WalletSchema);
