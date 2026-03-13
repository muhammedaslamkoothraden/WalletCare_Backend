const mongoose = require("mongoose");

const otpSchema = new mongoose.Schema(
  {
    identifier: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true
    },

    purpose: {
      type: String,
      enum: ["signup", "reset_password"],
      required: true
    },

    otpHash: {
      type: String,
      default: null        // null after max attempts or successful verification
    },

    otpExhausted: {
      type: Boolean,
      default: false       // true when max attempts hit — blocks further verification
    },

    attempts: {
      type: Number,
      default: 0
    },

    resendCount: {
      type: Number,
      default: 0
    },

    lastSentAt: {
      type: Date,
      required: true
    },

    expiresAt: {
      type: Date,
      required: true
    }
  },
  { timestamps: true }
);

// one active OTP document per identifier + purpose
otpSchema.index({ identifier: 1, purpose: 1 }, { unique: true });

// no TTL index — document never auto deleted, expiry handled manually

module.exports = mongoose.model("Otp", otpSchema);