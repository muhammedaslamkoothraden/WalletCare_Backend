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


// Create OTP
// - upsert: updates existing document if found, creates new if not
// - resets all state on fresh OTP creation
exports.createOtp = async (identifier, purpose = "signup") => {
  const id = identifier.toLowerCase().trim();
  const { otp, otpHash } = await generateOtp();

  await Otp.findOneAndUpdate(
    { identifier: id, purpose },
    {
      otpHash,
      attempts: 0,
      otpExhausted: false,
      resendCount: 0,
      lastSentAt: new Date(),
      expiresAt: new Date(Date.now() + OTP_EXPIRY_MS)
    },
    { upsert: true, new: true }
  );

  await sendOtpEmail(id, otp);
};


// Resend OTP
// - otpExhausted only blocks verification, NOT resend
// - resendCount >= MAX_RESEND is the only resend block
// - expired OTP always allows fresh start regardless of otpExhausted
exports.resendOtp = async (identifier, purpose = "signup") => {
  const id = identifier.toLowerCase().trim();

  const record = await Otp.findOne({ identifier: id, purpose });

  if (!record) {
    // no document — treat as fresh start
    await exports.createOtp(id, purpose);
    return;
  }

  // manual expiry check — no TTL, document never auto deleted
  const isExpired = record.expiresAt < new Date();

  if (isExpired) {
    // OTP window expired — reset everything and allow fresh start
    await exports.createOtp(id, purpose);
    return;
  }

  if (record.resendCount >= MAX_RESEND) {
    // resend limit reached and window still active — block
    const secondsLeft = Math.ceil((record.expiresAt - new Date()) / 1000);
    const err = new Error("MAX_RESEND_EXHAUSTED");
    err.retryAfter = secondsLeft;
    throw err;
  }

  if (Date.now() - record.lastSentAt.getTime() < COOLDOWN_MS) throw new Error("COOLDOWN_ACTIVE");

  const { otp, otpHash } = await generateOtp();

  // reset attempts and otpExhausted — new OTP means fresh verification window
  record.otpHash = otpHash;
  record.attempts = 0;
  record.otpExhausted = false;
  record.resendCount += 1;
  record.lastSentAt = new Date();
  record.expiresAt = new Date(Date.now() + OTP_EXPIRY_MS);

  await record.save();
  await sendOtpEmail(id, otp);
};


// Verify OTP
// - session support for MongoDB transactions
// - on max attempts: nulls otpHash, sets otpExhausted — document stays alive for resend tracking
// - on success: deletes document — no longer needed after verification
exports.verifyOtp = async (identifier, otp, purpose = "signup", session = null) => {
  const id = identifier.toLowerCase().trim();

  const record = await Otp.findOne({ identifier: id, purpose }).session(session);

  if (!record) throw new Error("OTP not found. Please request a new one.");

  // manual expiry check
  if (record.expiresAt < new Date()) {
    throw new Error("OTP expired. Please request a new one.");
  }

  // otpExhausted — max verify attempts already hit, no more verification allowed
  if (record.otpExhausted || !record.otpHash) {
    throw new Error("Maximum OTP attempts exceeded. Please request a new OTP.");
  }

  const isValid = await bcrypt.compare(otp, record.otpHash);

  if (!isValid) {
    // increment attempts and get updated value
    const updated = await Otp.findOneAndUpdate(
      { _id: record._id },
      { $inc: { attempts: 1 } },
      { new: true }
    );

    if (!updated) throw new Error("OTP not found. Please request a new one.");

    if (updated.attempts >= MAX_VERIFY_ATTEMPTS) {
      // null otpHash + set exhausted — document stays alive for resend tracking
      await Otp.findByIdAndUpdate(record._id, {
        otpHash: null,
        otpExhausted: true
      });
      const error = new Error("Maximum OTP attempts exceeded. Please request a new OTP.");
      error.code = "MAX_ATTEMPTS_EXCEEDED";
      throw error;
    }

    throw new Error(`Invalid OTP. ${MAX_VERIFY_ATTEMPTS - updated.attempts} attempt(s) remaining.`);
  }

  // OTP verified — delete document, no longer needed
  await Otp.findOneAndDelete({ _id: record._id }, { session });

  return true;
};