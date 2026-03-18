const mongoose = require("mongoose");
const { User, PendingUser } = require("../models/user");
const { initializeAccountForUser } = require("../services/Account.service");
const { verifyOtp } = require("../services/otp.service");

const { generateAccessToken, generateRefreshToken } = require("../utils/token");
const hashToken = require("../utils/hashToken");


// Verify Email OTP
exports.verifyEmailOtp = async (req, res) => {

  // start transaction — all DB ops succeed or all rollback
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

    // throws if OTP is invalid, expired, or max attempts exceeded
    // otp.service handles otpExhausted internally — no PendingUser update needed
    await verifyOtp(normalizedEmail, otp, "signup", session);

    // promote pending → main User collection
    const newUser = new User({
      name: pendingUser.name,
      email: pendingUser.email,
      password: pendingUser.password,   // already hashed from registration
      role: pendingUser.role,
      isEmailVerified: true
    });

    newUser.$ignoreHooks = true;        // skip pre-save hash — password already hashed
    await newUser.save({ session });

    // initialize wallet/account atomically with user creation
    await initializeAccountForUser(newUser._id, session);

    // generate tokens via utils
    const accessToken = generateAccessToken(newUser._id, newUser.role);
    const refreshToken = generateRefreshToken(newUser._id);

    // store hashed refresh token inside transaction — rolls back if anything fails
    await User.findByIdAndUpdate(
      newUser._id,
      { refreshToken: hashToken(refreshToken) },
      { session }
    );

    // delete pending record after successful promotion
    await PendingUser.deleteOne({ _id: pendingUser._id }).session(session);

    await session.commitTransaction();
    session.endSession();

    return res.status(200).json({
      message: "Email verified successfully. Account activated.",
      accessToken,
      refreshToken,
      user: {
        id: newUser._id,
        name: newUser.name,
        email: newUser.email,
        role: newUser.role,
        isPremium: newUser.isPremium,
        isEmailVerified: newUser.isEmailVerified
      }
    });

  } catch (error) {

    // rollback all DB changes on any failure
    await session.abortTransaction();
    session.endSession();

    console.error("verifyEmailOtp error:", error.message);

    // otp.service handles otpExhausted internally — just return error message
    if (error.code === "MAX_ATTEMPTS_EXCEEDED") {
      return res.status(400).json({ message: "Maximum OTP attempts exceeded. Please request a new OTP." });
    }

    return res.status(400).json({ message: error.message || "OTP verification failed" });
  }
};