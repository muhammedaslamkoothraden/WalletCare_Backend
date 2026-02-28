const mongoose = require('mongoose');
const Decimal = require('decimal.js');

const AccountSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 32 },
    type: { type: String, enum: ['CASH', 'BANK'], required: true, uppercase: true },
    availableBalance: { type: mongoose.Schema.Types.Decimal128, default: "0.00" },
    reservedBalance: { type: mongoose.Schema.Types.Decimal128, default: "0.00" },
    currency: { type: String, default: 'INR', uppercase: true },
    isDefault: { type: Boolean, default: false },
    status: { type: String, enum: ['ACTIVE', 'FROZEN', 'CLOSED'], default: 'ACTIVE' }
  },
  { 
    timestamps: true,
    // CRITICAL: This allows the 'totalBalance' to show up in your JSON responses
    toJSON: { virtuals: true, getters: true },
    toObject: { virtuals: true, getters: true }
  }
);

// --- THE NEW VIRTUAL TOTAL ---
// This calculates the total on-the-fly. No 'next()' function needed!
AccountSchema.virtual('totalBalance').get(function() {
  const avail = new Decimal(this.availableBalance ? this.availableBalance.toString() : "0");
  const res = new Decimal(this.reservedBalance ? this.reservedBalance.toString() : "0");
  return avail.plus(res).toFixed(2);
});

AccountSchema.index({ userId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('Account', AccountSchema);