const mongoose = require("mongoose");

const otpSchema = new mongoose.Schema(
  {
    identifier: { type: String, required: true, lowercase: true, trim: true, index: true },
    purpose: { type: String, required: true, enum: ["signup", "reset_password"] },
    otpHash: { type: String, default: null },
    otpExhausted: { type: Boolean, default: false },
    attempts: { type: Number, default: 0 },
    resendCount: { type: Number, default: 0 },
    lastSentAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// One active OTP per identifier + purpose
otpSchema.index({ identifier: 1, purpose: 1 }, { unique: true });

// No TTL — expiry is handled manually in otp.service.js

module.exports = mongoose.models.Otp || mongoose.model("Otp", otpSchema);