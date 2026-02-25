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

// Add session to the parameters
exports.verifyOtp = async (identifier, otp, purpose = "signup", session = null) => {
  const normalizedIdentifier = identifier.toLowerCase().trim();

  // 1. Pass session to findOne
  const record = await Otp.findOne({
    identifier: normalizedIdentifier,
    purpose
  }).session(session);

  if (!record) {
    throw new Error("OTP expired or not found");
  }

  if (record.expiresAt < new Date()) {
    await Otp.deleteOne({ _id: record._id }).session(session); // Pass session
    throw new Error("OTP expired");
  }

  const isValid = await bcrypt.compare(otp, record.otpHash);

  if (!isValid) {
    record.attempts = (record.attempts || 0) + 1;
    await record.save({ session }); // Pass session

    if (record.attempts >= 5) {
      await Otp.deleteOne({ _id: record._id }).session(session); // Pass session
      throw new Error("Maximum OTP attempts exceeded");
    }
    throw new Error("Invalid OTP");
  }

  // 2. Pass session to the final deletion
  await Otp.deleteOne({ _id: record._id }).session(session);

  return true;
};