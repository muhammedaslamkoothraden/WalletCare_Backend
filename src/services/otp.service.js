const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const Otp = require("../models/otp");
const { sendOtpEmail } = require("./email.service");

exports.sendOtp = async (email) => {
  const otp = crypto.randomInt(100000, 999999).toString();

  const otpHash = await bcrypt.hash(otp, 10);

  // One active OTP per email
  await Otp.deleteMany({ email });

  await Otp.create({
    email,
    otpHash,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000) // 30 minutes
  });

  await sendOtpEmail(email, otp);
};
exports.verifyOtp = async (email, otp) => {
  const record = await Otp.findOne({ email });

  if (!record) {
    throw new Error("OTP expired or not found");
  }

  const isValid = await bcrypt.compare(otp, record.otpHash);

  if (!isValid) {
    throw new Error("Invalid OTP");
  }

  // OTP used → delete immediately
  await Otp.deleteOne({ _id: record._id });

  return true;
};
