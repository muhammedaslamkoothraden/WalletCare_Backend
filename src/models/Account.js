const mongoose = require('mongoose');
const Decimal = require('decimal.js');

/**
 * @desc    User Account Schema (Represents Main Wallets & Bank Accounts)
 * @notes   Financial values are strictly stored as Decimal128 to prevent 
 * floating-point calculation errors inherent in standard JavaScript numbers.
 */
const AccountSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 32
    },
    type: {
      type: String,
      enum: ['CASH', 'BANK'],
      required: true,
      uppercase: true
    },
    availableBalance: {
      type: mongoose.Schema.Types.Decimal128,
      default: "0.00",
      min: [0, 'Available balance cannot be negative'] 
    },
    reservedBalance: {
      type: mongoose.Schema.Types.Decimal128,
      default: "0.00",
      min: [0, 'Reserved balance cannot be negative']
    },
    currency: {
      type: String,
      default: 'INR',
      uppercase: true
    },
    isDefault: {
      type: Boolean,
      default: false
    },
    status: {
      type: String,
      enum: ['ACTIVE', 'FROZEN', 'CLOSED'],
      default: 'ACTIVE'
    }
  },
  { 
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

AccountSchema.index({ userId: 1, name: 1 }, { unique: true });

AccountSchema.virtual('totalBalance').get(function() {
  const avail = new Decimal(this.availableBalance?.toString() || "0");
  const res = new Decimal(this.reservedBalance?.toString() || "0");
  return avail.plus(res).toFixed(2);
});

module.exports = mongoose.model('Account', AccountSchema);