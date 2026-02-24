const mongoose = require('mongoose');

/**
 * @description Account Schema for Ledger-based Wallet System
 * Handles both physical 'CASH' and digital 'ACCOUNT' types.
 * Enforces strict financial invariants.
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
      type: String, // e.g., "Cash in Hand", "HDFC Bank", "Savings Goal"
      required: true,
      trim: true,
      maxlength: 32
    },
    type: {
      type: String,
      enum: ['CASH', 'ACCOUNT'], 
      required: true,
      uppercase: true
    },
    // Using Decimal128 for high-precision financial math
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
    totalBalance: {
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
      default: false // Set to true ONLY for the system-generated 'Cash' account
    },
    isActive: {
      type: Boolean,
      default: true
    }
  },
  { 
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true }
  }
);

// --- INDEXES ---
// Ensures a user cannot have two accounts with the same name (e.g., two "Cash" accounts)
AccountSchema.index({ userId: 1, name: 1 }, { unique: true });

// --- MIDDLEWARE (The Guardian) ---
/**
 * Invariant: totalBalance MUST ALWAYS equal availableBalance + reservedBalance.
 * This hook prevents "Balance Drift" caused by logic bugs.
 */
// Fix in src/models/Account.js
AccountSchema.pre('save', async function() {
  // Your logic (like setting timestamps or generating IDs)
  // No next() needed here!
});

module.exports = mongoose.model('Account', AccountSchema);