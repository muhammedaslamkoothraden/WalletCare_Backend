const { User, PendingUser } = require("../models/user");
const { createOtp, resendOtp } = require("../services/otp.service");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

// SHA-256 hash for refresh tokens — deterministic, allows atomic DB lookup
function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

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

    // Block if already a verified user
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(400).json({ message: "An account with this email already exists" });
    }

    const existingPending = await PendingUser.findOne({ email: normalizedEmail });

    if (existingPending) {
      // Update pending record with latest submitted data before resending
      const hashedPassword = await bcrypt.hash(password, 10);
      await PendingUser.findOneAndUpdate(
        { email: normalizedEmail },
        { name, password: hashedPassword, phone },
        { new: true }
      );

      try {
        await resendOtp(normalizedEmail, "signup");
        return res.status(200).json({ message: "A verification OTP has been sent to your email" });

      } catch (resendError) {
        // OTP deleted (expired or max attempts) — start fresh lifecycle
        if (resendError.message === "OTP_EXPIRED") {
          await createOtp(normalizedEmail, "signup");
          return res.status(200).json({ message: "A verification OTP has been sent to your email" });
        }

        if (resendError.message === "COOLDOWN_ACTIVE") {
          return res.status(429).json({ message: "Please wait 60 seconds before requesting another OTP" });
        }

        if (resendError.message === "RESEND_LIMIT_REACHED") {
          return res.status(429).json({ message: "Maximum resend attempts reached. Please wait for the OTP to expire" });
        }

        throw resendError;
      }
    }

    // No existing record — create pending user and send OTP
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

    // Explicitly select password since it is excluded in schema
    const user = await User.findOne({ email: normalizedEmail }).select("+password");

    // Prevent user enumeration — generic message for missing user
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

    // Short-lived access token
    const accessToken = jwt.sign(
      { userId: user._id, role: user.role },
      process.env.ACCESS_TOKEN_SECRET,
      { expiresIn: process.env.ACCESS_TOKEN_EXPIRY }
    );

    // Long-lived refresh token
    const refreshToken = jwt.sign(
      { userId: user._id },
      process.env.REFRESH_TOKEN_SECRET,
      { expiresIn: process.env.REFRESH_TOKEN_EXPIRY }
    );

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
    // Avoid leaking internal error details
    return res.status(500).json({ message: "Server error" });
  }
};

// Resend OTP
exports.resendEmailOtp = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const pendingUser = await PendingUser.findOne({ email: normalizedEmail });
    if (!pendingUser) {
      // Generic response — never reveal whether email exists
      return res.status(200).json({ message: "If a pending registration exists, a new OTP has been sent." });
    }

    try {
      await resendOtp(normalizedEmail, "signup");
    } catch (resendError) {
      if (resendError.message === "RESEND_LIMIT_REACHED") {
        return res.status(429).json({ message: "Maximum resend attempts reached. Please wait until the OTP expires." });
      }

      if (resendError.message === "COOLDOWN_ACTIVE") {
        return res.status(429).json({ message: "Please wait 60 seconds before requesting another OTP." });
      }

      // OTP no longer exists — create fresh OTP without resetting pending user
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

// Refresh Access Token
exports.refreshAccessToken = async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(401).json({ message: "Refresh token required" });
    }

    // Verify signature and expiry
    let decoded;
    try {
      decoded = jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET);
    } catch (err) {
      if (err.name === "TokenExpiredError") {
        return res.status(401).json({ message: "Refresh token expired. Please login again." });
      }
      return res.status(401).json({ message: "Invalid refresh token" });
    }

    const hashedToken = hashToken(refreshToken);

    // Generate new refresh token before atomic swap
    const newRefreshToken = jwt.sign(
      { userId: decoded.userId },
      process.env.REFRESH_TOKEN_SECRET,
      { expiresIn: process.env.REFRESH_TOKEN_EXPIRY }
    );

    // Atomic swap — find by old hash, replace with new hash in one query
    // prevents replay attack — if already rotated, user will be null
    const user = await User.findOneAndUpdate(
      { _id: decoded.userId, refreshToken: hashedToken },
      { $set: { refreshToken: hashToken(newRefreshToken) } },
      { new: false }
    );

    if (!user) {
      // Reuse detected — wipe token from DB and force re-login
      await User.findByIdAndUpdate(decoded.userId, { refreshToken: null });
      return res.status(401).json({ message: "Refresh token reuse detected. Please login again." });
    }

    // Generate access token using role from DB doc — decoded has no role
    const newAccessToken = jwt.sign(
      { userId: user._id, role: user.role },
      process.env.ACCESS_TOKEN_SECRET,
      { expiresIn: process.env.ACCESS_TOKEN_EXPIRY }
    );

    return res.status(200).json({
      accessToken: newAccessToken,
      refreshToken: newRefreshToken  // client must save this — old one is now dead
    });

  } catch (error) {
    console.error("refreshAccessToken error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};