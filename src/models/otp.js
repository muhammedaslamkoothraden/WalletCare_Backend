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
      required: true
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

/*
  Ensure only ONE active OTP per identifier + purpose
  Example:
  - One signup OTP per email
  - One reset_password OTP per email
*/
otpSchema.index({ identifier: 1, purpose: 1 }, { unique: true });

otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("Otp", otpSchema);