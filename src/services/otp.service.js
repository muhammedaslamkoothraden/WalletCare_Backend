const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const Otp = require("../models/otp");
const { sendOtpEmail } = require("./email.service");

exports.sendOtp = async (identifier, purpose = "signup") => {
  const normalizedIdentifier = identifier.toLowerCase().trim();

  // Generate 6-digit numeric OTP
  const otp = crypto.randomInt(100000, 999999).toString();
  const otpHash = await bcrypt.hash(otp, 10);

  // Ensure only one active OTP per identifier + purpose
  await Otp.deleteMany({ identifier: normalizedIdentifier, purpose });

  await Otp.create({
    identifier: normalizedIdentifier,
    purpose,
    otpHash,
    attempts: 0,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000) // 10 min validity
  });

  // Send plain OTP to user (never store plain OTP)
  await sendOtpEmail(normalizedIdentifier, otp);
};

exports.verifyOtp = async (identifier, otp, purpose = "signup") => {
  const normalizedIdentifier = identifier.toLowerCase().trim();

  const record = await Otp.findOne({
    identifier: normalizedIdentifier,
    purpose
  });

  if (!record) {
    throw new Error("OTP expired or not found");
  }

  // Do not rely only on TTL index (TTL cleanup is not immediate)
  if (record.expiresAt < new Date()) {
    await Otp.deleteOne({ _id: record._id });
    throw new Error("OTP expired");
  }

  const isValid = await bcrypt.compare(otp, record.otpHash);

  if (!isValid) {
    record.attempts = (record.attempts || 0) + 1;
    await record.save();

    // Lock after 5 failed attempts
    if (record.attempts >= 5) {
      await Otp.deleteOne({ _id: record._id });
      throw new Error("Maximum OTP attempts exceeded");
    }

    throw new Error("Invalid OTP");
  }

  // OTP consumed → delete immediately
  await Otp.deleteOne({ _id: record._id });

  return true;
};