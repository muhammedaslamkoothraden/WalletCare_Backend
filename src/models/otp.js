const mongoose = require("mongoose");

const otpSchema = new mongoose.Schema(
  {
    // Email or unique identifier
    identifier: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true
    },

    // Purpose separation to prevent cross-usage
    purpose: {
      type: String,
      enum: ["signup", "reset_password"],
      required: true
    },

    // Hashed OTP (never store plain OTP)
    otpHash: {
      type: String,
      required: true
    },

    // Number of incorrect verification attempts
    attempts: {
      type: Number,
      default: 0
    },

    // Number of resend attempts within lifecycle
    resendCount: {
      type: Number,
      default: 0
    },

    // Timestamp of last OTP sent (for cooldown logic)
    lastSentAt: {
      type: Date,
      required: true
    },

    // Expiry time
    expiresAt: {
      type: Date,
      required: true
    }
  },
  { timestamps: true }
);

/*
  Ensure only ONE active OTP per identifier + purpose
  Example:
  - One signup OTP per email
  - One reset_password OTP per email
*/
otpSchema.index({ identifier: 1, purpose: 1 }, { unique: true });

/*
  TTL Index
  Automatically deletes OTP document when expiresAt time is reached.
*/
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("Otp", otpSchema);