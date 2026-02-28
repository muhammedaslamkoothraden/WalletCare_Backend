const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const Otp = require("../models/otp");
const { sendOtpEmail } = require("./email.service");

const OTP_EXPIRY_MS = 10 * 60 * 1000;
const COOLDOWN_MS = 60 * 1000;
const MAX_RESEND = 5;
const MAX_VERIFY_ATTEMPTS = 3;

// shared OTP generator used by createOtp and resendOtp
const generateOtp = async () => {
  const otp = crypto.randomInt(100000, 999999).toString();
  const otpHash = await bcrypt.hash(otp, 10);
  return { otp, otpHash };
};

exports.createOtp = async (identifier, purpose = "signup") => {
  const id = identifier.toLowerCase().trim();
  const { otp, otpHash } = await generateOtp();

  // upsert — replaces existing OTP if one exists for this identifier + purpose
  await Otp.findOneAndUpdate(
    { identifier: id, purpose },
    {
      otpHash,
      attempts: 0,
      resendCount: 0,
      lastSentAt: new Date(),
      expiresAt: new Date(Date.now() + OTP_EXPIRY_MS)
    },
    { upsert: true, new: true }
  );

  await sendOtpEmail(id, otp);
};

exports.resendOtp = async (identifier, purpose = "signup") => {
  const id = identifier.toLowerCase().trim();

  const record = await Otp.findOne({ identifier: id, purpose });

  if (!record) throw new Error("OTP_EXPIRED");

  // TTL deletion is not immediate — manual check required
  if (record.expiresAt < new Date()) {
    await Otp.deleteOne({ _id: record._id });
    throw new Error("OTP_EXPIRED");
  }

  if (record.resendCount >= MAX_RESEND) throw new Error("RESEND_LIMIT_REACHED");

  if (Date.now() - record.lastSentAt.getTime() < COOLDOWN_MS) throw new Error("COOLDOWN_ACTIVE");

  const { otp, otpHash } = await generateOtp();

  record.otpHash = otpHash;
  record.attempts = 0;
  record.resendCount += 1;
  record.lastSentAt = new Date();
  record.expiresAt = new Date(Date.now() + OTP_EXPIRY_MS); // fresh 10 min on every resend

  await record.save();
  await sendOtpEmail(id, otp);
};

exports.verifyOtp = async (identifier, otp, purpose = "signup", session = null) => {
  const id = identifier.toLowerCase().trim();

  // session support — runs inside transaction when provided
  const record = await Otp.findOne({ identifier: id, purpose }).session(session);

  if (!record) throw new Error("OTP expired or not found");

  if (record.expiresAt < new Date()) {
    await Otp.deleteOne({ _id: record._id }).session(session);
    throw new Error("OTP expired");
  }

  const isValid = await bcrypt.compare(otp, record.otpHash);

  if (!isValid) {
    // increment in DB and get real updated value back
    const updated = await Otp.findOneAndUpdate(
      { _id: record._id },
      { $inc: { attempts: 1 } },
      { new: true }
    );

    if (!updated) throw new Error("OTP expired or not found");

    if (updated.attempts >= MAX_VERIFY_ATTEMPTS) {
      await Otp.deleteOne({ _id: record._id });
      throw new Error("Maximum OTP attempts exceeded. Please request a new OTP.");
    }

    throw new Error(`Invalid OTP. ${MAX_VERIFY_ATTEMPTS - updated.attempts} attempt(s) remaining.`);
  }

  // OTP consumed — delete inside transaction
  await Otp.deleteOne({ _id: record._id }).session(session);

  return true;
};