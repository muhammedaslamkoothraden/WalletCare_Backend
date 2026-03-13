const { User, PendingUser } = require("../models/user");
const { resendOtp, verifyOtp } = require("../services/otp.service");
const { generateResetToken } = require("../utils/token");
const Otp = require("../models/otp");


// Resend OTP — public (login page + registration)
// handles both signup and reset_password via purpose field
// email comes from request body
exports.resendOtpHandler = async (req, res) => {
  try {
    const { email, purpose } = req.body;

    if (!email || !purpose) {
      return res.status(400).json({ message: "Email and purpose are required" });
    }

    if (!["signup", "reset_password"].includes(purpose)) {
      return res.status(400).json({ message: "Invalid purpose" });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // for signup — check pending user exists
    if (purpose === "signup") {
      const pendingUser = await PendingUser.findOne({ email: normalizedEmail });
      if (!pendingUser) {
        // generic response — never reveal whether email exists
        return res.status(200).json({ message: "If a pending registration exists, a new OTP has been sent." });
      }
    }

    // for reset_password — check verified user exists
    if (purpose === "reset_password") {
      const user = await User.findOne({ email: normalizedEmail });
      if (!user) {
        // generic response — never reveal whether email exists
        return res.status(200).json({ message: "If this email exists, a new OTP has been sent." });
      }
    }

    // block resend if no active OTP document exists
    // means forgot-password / register was never called first
    const existingOtp = await Otp.findOne({ identifier: normalizedEmail, purpose });
    if (!existingOtp) {
      return res.status(400).json({ message: "No active OTP request found. Please request a new OTP first." });
    }

    try {
      await resendOtp(normalizedEmail, purpose);
    } catch (resendError) {

      if (resendError.message === "COOLDOWN_ACTIVE") {
        return res.status(429).json({ message: "Please wait 60 seconds before requesting another OTP." });
      }

      if (resendError.message === "MAX_RESEND_EXHAUSTED") {
        return res.status(429).json({
          message: "Maximum resend attempts reached. Please wait for the OTP to expire.",
          retryAfter: resendError.retryAfter
        });
      }

      throw resendError;
    }

    return res.status(200).json({ message: "OTP resent successfully." });

  } catch (error) {
    console.error("resendOtpHandler error:", error.message);
    return res.status(500).json({ message: "Server error" });
  }
};


// Verify OTP — public (login page)
// reset_password only — signup verification handled by POST /auth/verify-email
// email comes from request body
exports.verifyOtpHandler = async (req, res) => {
  try {
    const { email, otp, purpose } = req.body;

    if (!email || !otp || !purpose) {
      return res.status(400).json({ message: "Email, OTP and purpose are required" });
    }

    if (purpose !== "reset_password") {
      return res.status(400).json({ message: "Invalid purpose. Use /auth/verify-email for signup." });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // throws if OTP invalid, expired, or max attempts exceeded
    await verifyOtp(normalizedEmail, otp, purpose);

    // OTP verified — issue short lived reset token as proof
    const resetToken = generateResetToken(user._id);

    return res.status(200).json({
      message: "OTP verified successfully.",
      resetToken  // frontend stores this temporarily — required for reset-password step
    });

  } catch (error) {
    console.error("verifyOtpHandler error:", error.message);

    if (error.code === "MAX_ATTEMPTS_EXCEEDED") {
      return res.status(400).json({ message: "Maximum OTP attempts exceeded. Please request a new OTP." });
    }

    return res.status(400).json({ message: error.message || "OTP verification failed" });
  }
};


// Resend OTP — protected (inside app)
// reset_password only — email comes from token, frontend sends only purpose
exports.resendOtpPrivate = async (req, res) => {
  try {
    const { purpose } = req.body;

    if (!purpose) {
      return res.status(400).json({ message: "Purpose is required" });
    }

    if (purpose !== "reset_password") {
      return res.status(400).json({ message: "Invalid purpose" });
    }

    // email from token — no need to trust frontend
    const email = req.user.email;

    // block resend if no active OTP document exists
    // means forgot-password was never called first
    const existingOtp = await Otp.findOne({ identifier: email, purpose });
    if (!existingOtp) {
      return res.status(400).json({ message: "No active OTP request found. Please request a new OTP first." });
    }

    try {
      await resendOtp(email, purpose);
    } catch (resendError) {

      if (resendError.message === "COOLDOWN_ACTIVE") {
        return res.status(429).json({ message: "Please wait 60 seconds before requesting another OTP." });
      }

      if (resendError.message === "MAX_RESEND_EXHAUSTED") {
        return res.status(429).json({
          message: "Maximum resend attempts reached. Please wait for the OTP to expire.",
          retryAfter: resendError.retryAfter
        });
      }

      throw resendError;
    }

    return res.status(200).json({ message: "OTP resent successfully." });

  } catch (error) {
    console.error("resendOtpPrivate error:", error.message);
    return res.status(500).json({ message: "Server error" });
  }
};


// Verify OTP — protected (inside app)
// reset_password only — email comes from token, frontend sends only otp + purpose
exports.verifyOtpPrivate = async (req, res) => {
  try {
    const { otp, purpose } = req.body;

    if (!otp || !purpose) {
      return res.status(400).json({ message: "OTP and purpose are required" });
    }

    if (purpose !== "reset_password") {
      return res.status(400).json({ message: "Invalid purpose" });
    }

    // email from token — no need to trust frontend
    const email = req.user.email;

    // throws if OTP invalid, expired, or max attempts exceeded
    await verifyOtp(email, otp, purpose);

    // OTP verified — issue short lived reset token as proof
    const resetToken = generateResetToken(req.user._id);

    return res.status(200).json({
      message: "OTP verified successfully.",
      resetToken  // frontend stores this temporarily — required for reset-password step
    });

  } catch (error) {
    console.error("verifyOtpPrivate error:", error.message);

    if (error.code === "MAX_ATTEMPTS_EXCEEDED") {
      return res.status(400).json({ message: "Maximum OTP attempts exceeded. Please request a new OTP." });
    }

    return res.status(400).json({ message: error.message || "OTP verification failed" });
  }
};