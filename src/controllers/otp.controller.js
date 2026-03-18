const { User, PendingUser } = require("../models/user");
const { resendOtp, verifyOtp } = require("../services/otp.service");
const { generateResetToken } = require("../utils/token");
const Otp = require("../models/otp");

// helper — handles resend errors consistently across routes
const handleResendError = (resendError, res) => {
  if (resendError.message === "COOLDOWN_ACTIVE") {
    return res.status(429).json({ message: "Please wait 60 seconds before requesting another OTP." });
  }
  if (resendError.message === "MAX_RESEND_EXHAUSTED") {
    return res.status(429).json({
      message: "Maximum resend attempts reached. Please wait for the OTP to expire.",
      retryAfter: resendError.retryAfter,
    });
  }
  return null;
};

// Resend OTP — public, handles signup and reset_password, email from body
exports.resendOtpHandler = async (req, res) => {
  try {
    const { email, purpose } = req.body;
    const normalizedEmail = email.toLowerCase().trim();

    // generic responses — never reveal whether email exists
    if (purpose === "signup") {
      const pendingUser = await PendingUser.findOne({ email: normalizedEmail });
      if (!pendingUser) {
        return res.status(200).json({ message: "If a pending registration exists, a new OTP has been sent." });
      }
    }

    if (purpose === "reset_password") {
      const user = await User.findOne({ email: normalizedEmail });
      if (!user) {
        return res.status(200).json({ message: "If this email exists, a new OTP has been sent." });
      }
    }

    // block resend if forgot-password / register was never called first
    const existingOtp = await Otp.findOne({ identifier: normalizedEmail, purpose });
    if (!existingOtp) {
      return res.status(400).json({ message: "No active OTP request found. Please request a new OTP first." });
    }

    try {
      await resendOtp(normalizedEmail, purpose);
    } catch (resendError) {
      const handled = handleResendError(resendError, res);
      if (handled) return handled;
      throw resendError;
    }

    return res.status(200).json({ message: "OTP resent successfully." });

  } catch (error) {
    console.error("resendOtpHandler error:", error.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// Verify OTP — public, reset_password only, signup handled by /auth/verify-email
exports.verifyOtpHandler = async (req, res) => {
  try {
    const { email, otp, purpose } = req.body;
    const normalizedEmail = email.toLowerCase().trim();

    const user = await User.findOne({ email: normalizedEmail });
    if (!user) return res.status(404).json({ message: "User not found" });

    // throws if OTP invalid, expired, or max attempts exceeded
    await verifyOtp(normalizedEmail, otp, purpose);

    // OTP verified — issue short-lived reset token as proof
    const resetToken = generateResetToken(user._id);

    return res.status(200).json({
      message: "OTP verified successfully.",
      resetToken, // frontend stores temporarily — required for reset-password step
    });

  } catch (error) {
    console.error("verifyOtpHandler error:", error.message);
    if (error.code === "MAX_ATTEMPTS_EXCEEDED") {
      return res.status(400).json({ message: "Maximum OTP attempts exceeded. Please request a new OTP." });
    }
    return res.status(400).json({ message: error.message || "OTP verification failed" });
  }
};

// Resend OTP — protected, reset_password only, email from token
exports.resendOtpPrivate = async (req, res) => {
  try {
    const { purpose } = req.body;
    const email = req.user.email; // email from token — no need to trust frontend

    // block resend if forgot-password was never called first
    const existingOtp = await Otp.findOne({ identifier: email, purpose });
    if (!existingOtp) {
      return res.status(400).json({ message: "No active OTP request found. Please request a new OTP first." });
    }

    try {
      await resendOtp(email, purpose);
    } catch (resendError) {
      const handled = handleResendError(resendError, res);
      if (handled) return handled;
      throw resendError;
    }

    return res.status(200).json({ message: "OTP resent successfully." });

  } catch (error) {
    console.error("resendOtpPrivate error:", error.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// Verify OTP — protected, reset_password only, email from token
exports.verifyOtpPrivate = async (req, res) => {
  try {
    const { otp, purpose } = req.body;
    const email = req.user.email; // email from token — no need to trust frontend

    // throws if OTP invalid, expired, or max attempts exceeded
    await verifyOtp(email, otp, purpose);

    // OTP verified — issue short-lived reset token as proof
    const resetToken = generateResetToken(req.user._id);

    return res.status(200).json({
      message: "OTP verified successfully.",
      resetToken, // frontend stores temporarily — required for reset-password step
    });

  } catch (error) {
    console.error("verifyOtpPrivate error:", error.message);
    if (error.code === "MAX_ATTEMPTS_EXCEEDED") {
      return res.status(400).json({ message: "Maximum OTP attempts exceeded. Please request a new OTP." });
    }
    return res.status(400).json({ message: error.message || "OTP verification failed" });
  }
};