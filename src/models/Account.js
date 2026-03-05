const mongoose = require('mongoose');
const Decimal = require('decimal.js');

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
      default: "0.00"
    },
    reservedBalance: {
      type: mongoose.Schema.Types.Decimal128,
      default: "0.00"
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

// Unique name per user
AccountSchema.index({ userId: 1, name: 1 }, { unique: true });
AccountSchema.pre('save', async function() {
  // 1. Ensure balances exist as strings for Decimal.js
  const avail = new Decimal(this.availableBalance?.toString() || "0");
  const res = new Decimal(this.reservedBalance?.toString() || "0");
  
  // 2. Calculate
  const total = avail.plus(res);
  
  // 3. Assign back to Decimal128
  this.totalBalance = mongoose.Types.Decimal128.fromString(total.toFixed(2));
  
  // No next() needed here!
});

module.exports = mongoose.model('Account', AccountSchema);