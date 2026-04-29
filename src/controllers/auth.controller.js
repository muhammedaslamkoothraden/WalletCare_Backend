const { User, PendingUser } = require("../models/user");
const { createOtp, resendOtp } = require("../services/otp.service");
const Otp = require("../models/otp");
const bcrypt = require("bcryptjs");
const { generateAccessToken, generateRefreshToken, verifyRefreshToken, verifyResetToken } = require("../utils/token");
const hashToken = require("../utils/hashToken");

// Helper — retry operation with exponential backoff (for MongoDB Atlas transient failures)
const retryOperation = async (fn, retries = 3, delay = 1000) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err;
      console.warn(`Retry ${i + 1}/${retries} after error:`, err.message);
      await new Promise(res => setTimeout(res, delay * (i + 1)));
    }
  }
};

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

// Register — creates pending user and sends OTP, respects cooldown on re-register
exports.registerUser = async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const normalizedEmail = email.toLowerCase().trim();

    // block if already a verified user
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(400).json({ message: "An account with this email already exists" });
    }

    const existingPending = await PendingUser.findOne({ email: normalizedEmail });

    if (existingPending) {
      // update pending record with latest submitted data
      const hashedPassword = await bcrypt.hash(password, 10);
      await PendingUser.findOneAndUpdate(
        { email: normalizedEmail },
        { name, password: hashedPassword },
        { new: true }
      );

      // check if OTP document already exists — respect cooldown + resend limits
      const existingOtp = await Otp.findOne({ identifier: normalizedEmail, purpose: "signup" });

      if (existingOtp) {
        try {
          await resendOtp(normalizedEmail, "signup");
        } catch (resendError) {
          const handled = handleResendError(resendError, res);
          if (handled) return handled;
          throw resendError;
        }
      } else {
        await createOtp(normalizedEmail, "signup");
      }

      return res.status(200).json({ message: "A verification OTP has been sent to your email" });
    }

    // no existing record — create pending user and send OTP
    const hashedPassword = await bcrypt.hash(password, 10);
    await PendingUser.create({ name, email: normalizedEmail, password: hashedPassword, role: "user" });
    await createOtp(normalizedEmail, "signup");

    return res.status(201).json({ message: "Registration successful. Please verify your email" });

  } catch (error) {
    // E11000 — handles race condition on unique email index
    if (error.code === 11000) {
      return res.status(400).json({ message: "An account with this email already exists" });
    }
    console.error("registerUser error:", error.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// Login — verifies credentials, auto-recovers soft-deleted accounts, issues tokens
exports.loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = email.toLowerCase().trim();

    // explicitly select password since it is excluded in schema
    const user = await User.findOne({ email: normalizedEmail }).select("+password");

    // prevent user enumeration — generic message for missing user
    if (!user) return res.status(401).json({ message: "Invalid credentials" });

    if (!user.isEmailVerified) {
      return res.status(403).json({ message: "Please verify your email before logging in" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ message: "Invalid credentials" });

    // block banned users after password check
    if (user.isBanned) {
      return res.status(403).json({ message: "Your account has been suspended" });
    }

    // auto recover — if account was scheduled for deletion, cancel it silently
    if (user.scheduledDeletionAt) {
      await User.findByIdAndUpdate(user._id, { scheduledDeletionAt: null });
    }

    const accessToken = generateAccessToken(user._id, user.role);
    const refreshToken = generateRefreshToken(user._id);

    // findByIdAndUpdate avoids triggering password re-hash in pre-save hook
    await User.findByIdAndUpdate(user._id, { refreshToken: hashToken(refreshToken) });

    return res.status(200).json({
      accessToken,
      refreshToken,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        isPremium: user.isPremium,
        isEmailVerified: user.isEmailVerified,
      },
    });

  } catch (error) {
    console.error("loginUser error:", error.message);
    return res.status(500).json({ message: "Server error" });
  }
};
// Forgot Password — sends OTP to email, generic response to prevent email enumeration
exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    const normalizedEmail = email.toLowerCase().trim();

    // generic response — never reveal whether email exists
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(200).json({ message: "If this email exists, an OTP has been sent" });
    }

    // check if OTP document already exists — respect cooldown + resend limits
    const existingOtp = await Otp.findOne({ identifier: normalizedEmail, purpose: "reset_password" });

    if (existingOtp) {
      try {
        await resendOtp(normalizedEmail, "reset_password");
      } catch (resendError) {
        const handled = handleResendError(resendError, res);
        if (handled) return handled;
        throw resendError;
      }
    } else {
      await createOtp(normalizedEmail, "reset_password");
    }

    return res.status(200).json({ message: "If this email exists, an OTP has been sent" });

  } catch (error) {
    console.error("forgotPassword error:", error.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// Reset Password — requires resetToken from POST /api/otp/verify
exports.resetPassword = async (req, res) => {
  try {
    const { resetToken, newPassword } = req.body;

    let decoded;
    try {
      decoded = verifyResetToken(resetToken);
    } catch (err) {
      if (err.name === "TokenExpiredError") {
        return res.status(401).json({ message: "Reset token expired. Please verify OTP again." });
      }
      return res.status(401).json({ message: "Invalid reset token" });
    }

    // ensure token purpose is correct — reject if access token used here
    if (decoded.purpose !== "reset_password") {
      return res.status(401).json({ message: "Invalid reset token" });
    }

    const user = await User.findById(decoded.userId).select("+password");
    if (!user) return res.status(404).json({ message: "User not found" });

    // prevent reusing same password
    const isSame = await bcrypt.compare(newPassword, user.password);
    if (isSame) {
      return res.status(400).json({ message: "New password must be different from current password" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // save new password + clear refresh token — forces re-login on all devices
    await User.findByIdAndUpdate(decoded.userId, { password: hashedPassword, refreshToken: null });

    return res.status(200).json({ message: "Password reset successfully. Please login again." });

  } catch (error) {
    console.error("resetPassword error:", error.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// Refresh Access Token — atomic token rotation with retry logic and proper error handling
exports.refreshAccessToken = async (req, res) => {
  try {
    const { refreshToken } = req.body;

    // Verify refresh token
    let decoded;
    try {
      decoded = verifyRefreshToken(refreshToken);
    } catch (err) {
      if (err.name === "TokenExpiredError") {
        return res.status(401).json({ message: "Refresh token expired. Please login again." });
      }
      return res.status(401).json({ message: "Invalid refresh token" });
    }

    const hashedToken = hashToken(refreshToken);
    const newRefreshToken = generateRefreshToken(decoded.userId);

    // Atomic swap with retry — find by old hash, replace with new hash in one query
    // Prevents replay attack — if already rotated, user will be null
    let user;
    try {
      user = await retryOperation(() =>
        User.findOneAndUpdate(
          { _id: decoded.userId, refreshToken: hashedToken },
          { $set: { refreshToken: hashToken(newRefreshToken) } },
          { new: false }
        )
      );
    } catch (dbError) {
      // Database query failed after retries (network issue, Atlas pause, timeout, etc.)
      // DO NOT wipe the token — this is a transient error, not a security issue
      console.error("refreshAccessToken DB error after retries:", dbError);
      return res.status(503).json({ message: "Database temporarily unavailable. Please try again." });
    }

    if (!user) {
      // Query succeeded but no user found with matching token
      // This could mean: (a) token reuse detected, or (b) user deleted
      
      // First check if user still exists
      const userExists = await User.findById(decoded.userId);
      
      if (!userExists) {
        // User account was deleted
        return res.status(401).json({ message: "User not found" });
      }

      // User exists but token doesn't match = reuse detected
      // Wipe the stored token to force re-login on all devices
      await User.findByIdAndUpdate(decoded.userId, { refreshToken: null });
      return res.status(401).json({ message: "Refresh token reuse detected. Please login again." });
    }

    // Success — generate new access token using role from DB
    // (decoded refresh token doesn't contain role, only userId)
    const newAccessToken = generateAccessToken(user._id, user.role);

    return res.status(200).json({
      accessToken: newAccessToken,
      refreshToken: newRefreshToken, // client must save this — old one is now invalidated
    });

  } catch (error) {
    console.error("refreshAccessToken error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};