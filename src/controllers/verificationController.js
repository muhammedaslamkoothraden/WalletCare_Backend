const mongoose = require("mongoose");
const { User, PendingUser } = require("../models/user");
const { initializeAccountForUser } = require("../services/Account.service");
const { verifyOtp, resendOtp, createOtp } = require("../services/otp.service");

exports.verifyEmailOtp = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: "Email and OTP are required" });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const pendingUser = await PendingUser.findOne({ email: normalizedEmail }).session(session);
    if (!pendingUser) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: "No pending registration found for this email" });
    }

    // Verify OTP — runs inside transaction (OTP deleted on success)
    await verifyOtp(normalizedEmail, otp, "signup", session);

    const newUser = new User({
      name: pendingUser.name,
      email: pendingUser.email,
      password: pendingUser.password, // already hashed
      phone: pendingUser.phone,
      role: pendingUser.role,
      isEmailVerified: true
    });

    newUser.$ignoreHooks = true; // skip pre-save hash — password already hashed
    await newUser.save({ session });

    await initializeAccountForUser(newUser._id, session);
    
    await PendingUser.deleteOne({ _id: pendingUser._id }).session(session);

    await session.commitTransaction();
    session.endSession();

    return res.status(200).json({ message: "Email verified successfully. Account activated." });

  } catch (error) {
    await session.abortTransaction();
    session.endSession();

    console.error("verifyEmailOtp error:", error.message);

    return res.status(400).json({ message: error.message || "OTP verification failed" });
  }
};

exports.resendEmailOtp = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const pendingUser = await PendingUser.findOne({ email: normalizedEmail });
    if (!pendingUser) {
      // Generic response — do not reveal whether email exists
      return res.status(200).json({
        message: "If a pending registration exists, a new OTP has been sent."
      });
    }

    try {
      await resendOtp(normalizedEmail, "signup");
    } catch (resendError) {
      if (resendError.message === "RESEND_LIMIT_REACHED") {
        return res.status(429).json({
          message: "Maximum resend attempts reached. Please wait until the OTP expires."
        });
      }

      if (resendError.message === "COOLDOWN_ACTIVE") {
        return res.status(429).json({
          message: "Please wait 60 seconds before requesting another OTP."
        });
      }

      // OTP expired or deleted after max attempts — create fresh OTP
      if (resendError.message === "OTP_EXPIRED") {
        await createOtp(normalizedEmail, "signup");
        return res.status(200).json({ message: "OTP resent successfully." });
      }

      throw resendError;
    }

    return res.status(200).json({ message: "OTP resent successfully." });

  } catch (error) {
    console.error("resendEmailOtp error:", error.message);
    return res.status(500).json({ message: "Failed to resend OTP. Please try again." });
  }
};