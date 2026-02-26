const mongoose = require('mongoose');

/**
 * Account Schema for WalletCare
 * Handles both physical 'CASH' and digital 'BANK' types.
 * Demonstrates: Precision math, Invariant protection, and Transactional safety.
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
      maxlength: 32 // Keeps UI clean in Flutter
    },
    type: {
      type: String,
      enum: ['CASH', 'BANK',], 
      required: true,
      uppercase: true
    },
    // High-precision financial math using Decimal128
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
      uppercase: true,
      minlength: 3,
      maxlength: 3
    },
    isDefault: {
      type: Boolean,
      default: false 
    },
    isActive: {
      type: Boolean,
      default: true
    }
  },
  { 
    timestamps: true,
    optimisticConcurrency: true, // Prevents race conditions during updates
    toJSON: { getters: true },
    toObject: { getters: true }
  }
);

// --- INDEXES ---
// Ensures a user cannot have two accounts with the same name (e.g., two "Cash" accounts)
AccountSchema.index({ userId: 1, name: 1 }, { unique: true });

// --- VIRTUALS ---
// Useful for the Flutter frontend to get a simple string/number
AccountSchema.virtual('formattedTotal').get(function() {
  return this.totalBalance ? this.totalBalance.toString() : "0.00";
});

// --- MIDDLEWARE (The Guardian) ---
/**
 * Invariant: totalBalance MUST ALWAYS equal availableBalance + reservedBalance.
 * This runs before every .save() call to prevent "Balance Drift".
 */
AccountSchema.pre('save', function(next) {
  try {
    const avail = parseFloat(this.availableBalance.toString() || "0");
    const res = parseFloat(this.reservedBalance.toString() || "0");
    
    // Automatically set totalBalance
    this.totalBalance = mongoose.Types.Decimal128.fromString((avail + res).toFixed(2));
    
    // Successfully move to the next middleware or save operation
    // next();
  } catch (error) {
    // If math fails, pass the error to the next step to stop the save
    next(error);
  }
});

module.exports = mongoose.model('Account', AccountSchema);