const mongoose = require("mongoose");
const { User, PendingUser } = require("../models/user");
const { initializeAcountForUser } = require("../services/Account.service");
const { verifyOtp } = require("../services/otp.service");

exports.verifyEmailOtp = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ message: "Email and OTP are required" });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // 1. Find pending user
    const pendingUser = await PendingUser.findOne({ email: normalizedEmail }).session(session);
    if (!pendingUser) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: "Pending user not found or expired" });
    }

    // 2. Verify OTP (service deletes OTP on success)
    await verifyOtp(normalizedEmail, otp, "signup",session);

    // 3. Move pending user to main User collection
    const newUser = new User({
      name: pendingUser.name,
      email: pendingUser.email,
      password: pendingUser.password, // already hashed
      phone: pendingUser.phone,
      role: pendingUser.role,
      isEmailVerified: true
    });

    // Prevent pre-save hashing since password is already hashed
    newUser.$ignoreHooks = true;

    await newUser.save({ session });

    // 4. Initialize account inside transaction
    await initializeAcountForUser(newUser._id, session); // make sure Acount.service supports session

    // 5. Delete pending user
    await PendingUser.deleteOne({ _id: pendingUser._id }).session(session);

    await session.commitTransaction();
    session.endSession();

    return res.status(200).json({
      message: "Email verified successfully, account activated"
    });

  } catch (error) {
    await session.abortTransaction();
    session.endSession();

    console.error("OTP Verification Error:", error);

    return res.status(400).json({
      message: error.message || "Invalid or expired OTP"
    });
  }
};