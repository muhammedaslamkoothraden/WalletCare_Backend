const { User, PendingUser } = require("../models/user");
const { createOtp, resendOtp } = require("../services/otp.service");
const Otp = require("../models/otp");
const bcrypt = require("bcryptjs");

const { generateAccessToken, generateRefreshToken, verifyRefreshToken, verifyResetToken } = require("../utils/token");
const hashToken = require("../utils/hashToken");


// Register
exports.registerUser = async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: "Name, email and password are required" });
    }

    if (password.length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    }

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
        { name, password: hashedPassword, phone },
        { new: true }
      );

      // check if OTP document already exists — respect cooldown + resend limits
      const existingOtp = await Otp.findOne({ identifier: normalizedEmail, purpose: "signup" });

      if (existingOtp) {
        try {
          await resendOtp(normalizedEmail, "signup");
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
      } else {
        // no existing OTP — fresh start
        await createOtp(normalizedEmail, "signup");
      }

      return res.status(200).json({ message: "A verification OTP has been sent to your email" });
    }

    // no existing record — create pending user and send OTP
    const hashedPassword = await bcrypt.hash(password, 10);

    await PendingUser.create({
      name,
      email: normalizedEmail,
      password: hashedPassword,
      phone,
      role: "user"
    });

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


// Login
exports.loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password required" });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // explicitly select password since it is excluded in schema
    const user = await User.findOne({ email: normalizedEmail }).select("+password");

    // prevent user enumeration — generic message for missing user
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    if (!user.isEmailVerified) {
      return res.status(403).json({ message: "Please verify your email before logging in" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // auto recover — if account was scheduled for deletion, cancel it silently
    if (user.scheduledDeletionAt) {
      await User.findByIdAndUpdate(user._id, { scheduledDeletionAt: null });
    }

    // generate tokens via utils — no raw jwt.sign calls here
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
        isEmailVerified: user.isEmailVerified
      }
    });

  } catch (error) {
    console.error("loginUser error:", error.message);
    return res.status(500).json({ message: "Server error" });
  }
};


// Forgot Password — send OTP to email (login page)
exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

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
    } else {
      // no existing OTP — fresh start
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

    if (!resetToken || !newPassword) {
      return res.status(400).json({ message: "Reset token and new password are required" });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    }

    // verify reset token
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
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // prevent reusing same password
    const isSame = await bcrypt.compare(newPassword, user.password);
    if (isSame) {
      return res.status(400).json({ message: "New password must be different from current password" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // save new password + clear refresh token — forces re-login on all devices
    await User.findByIdAndUpdate(decoded.userId, {
      password: hashedPassword,
      refreshToken: null
    });

    return res.status(200).json({ message: "Password reset successfully. Please login again." });

  } catch (error) {
    console.error("resetPassword error:", error.message);
    return res.status(500).json({ message: "Server error" });
  }
};


// Refresh Access Token
exports.refreshAccessToken = async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(401).json({ message: "Refresh token required" });
    }

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

    // generate new refresh token before atomic swap
    const newRefreshToken = generateRefreshToken(decoded.userId);

    // atomic swap — find by old hash, replace with new hash in one query
    // prevents replay attack — if already rotated, user will be null
    const user = await User.findOneAndUpdate(
      { _id: decoded.userId, refreshToken: hashedToken },
      { $set: { refreshToken: hashToken(newRefreshToken) } },
      { new: false }
    );

    if (!user) {
      // reuse detected — wipe token from DB and force re-login
      await User.findByIdAndUpdate(decoded.userId, { refreshToken: null });
      return res.status(401).json({ message: "Refresh token reuse detected. Please login again." });
    }

    // generate access token using role from DB doc — decoded has no role
    const newAccessToken = generateAccessToken(user._id, user.role);

    return res.status(200).json({
      accessToken: newAccessToken,
      refreshToken: newRefreshToken  // client must save this — old one is now dead
    });

  } catch (error) {
    console.error("refreshAccessToken error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};