const mongoose = require("mongoose");
const { User, PendingUser } = require("../models/user");
const { initializeAccountForUser } = require("../services/Account.service");
const { verifyOtp } = require("../services/otp.service");

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

    // OTP deleted by max wrong attempts — flag PendingUser to block resend bypass
    if (error.code === "MAX_ATTEMPTS_EXCEEDED") {
      await PendingUser.findOneAndUpdate(
        { email: req.body.email?.toLowerCase().trim() },
        { otpExhausted: true }
      );
      return res.status(400).json({ message: "Maximum OTP attempts exceeded. Please request a new OTP." });
    }

    return res.status(400).json({ message: error.message || "OTP verification failed" });
  }
};