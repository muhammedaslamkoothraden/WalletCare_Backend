const mongoose = require("mongoose");

const otpSchema = new mongoose.Schema(
  {
    identifier: { type: String, required: true, index: true },
    purpose: { type: String, enum: ["signup", "reset_password"], required: true },
    otpHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true }
  },
  { timestamps: true }
);

// Ensure one OTP per identifier + purpose
otpSchema.index({ identifier: 1, purpose: 1 }, { unique: true });

// TTL index for automatic deletion
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("Otp", otpSchema);