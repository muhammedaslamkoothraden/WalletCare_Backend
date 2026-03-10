const { User, PendingUser } = require("../models/user");
const Otp = require("../models/otp");
const { createOtp, resendOtp } = require("../services/otp.service");
const bcrypt = require("bcryptjs");

const { generateAccessToken, generateRefreshToken, verifyRefreshToken } = require("../utils/token");
const hashToken = require("../utils/hashToken");

const OTP_EXPIRY_MS = 10 * 60 * 1000;


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

      // Check resend limit before doing anything
      if (existingPending.resendCount >= 5) {
        if (existingPending.otpExhausted) {
          const now = new Date();
          const expiresAt = existingPending.otpExpiresAt;

          if (expiresAt && expiresAt > now) {
            // OTP deleted by max attempts and wait time not over
            const secondsLeft = Math.ceil((expiresAt - now) / 1000);
            const minutesLeft = Math.ceil(secondsLeft / 60);
            return res.status(429).json({
              message: `Maximum resend attempts reached. Please wait ${minutesLeft} minute(s) until the OTP expires.`,
              retryAfter: secondsLeft
            });
          }
          // otpExpiresAt passed — fall through and allow fresh start below
        } else {
          // OTP still alive — block
          return res.status(429).json({
            message: "Maximum resend attempts reached. Please wait until the OTP expires."
          });
        }
      }

      // Update pending record with latest submitted data before resending
      const hashedPassword = await bcrypt.hash(password, 10);
      await PendingUser.findOneAndUpdate(
        { email: normalizedEmail },
        { name, password: hashedPassword, phone },
        { new: true }
      );

      try {
        await resendOtp(normalizedEmail, "signup");
        await PendingUser.findOneAndUpdate(
          { email: normalizedEmail },
          { otpExpiresAt: new Date(Date.now() + OTP_EXPIRY_MS) }
        );
        return res.status(200).json({ message: "A verification OTP has been sent to your email" });

      } catch (resendError) {
        if (resendError.message === "OTP_EXPIRED") {
          await createOtp(normalizedEmail, "signup");
          await PendingUser.findOneAndUpdate(
            { email: normalizedEmail },
            {
              resendCount: 1,
              otpExhausted: false,
              otpExpiresAt: new Date(Date.now() + OTP_EXPIRY_MS)
            }
          );
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
      role: "user",
      otpExpiresAt: new Date(Date.now() + OTP_EXPIRY_MS)
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


// Resend OTP
exports.resendEmailOtp = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const pendingUser = await PendingUser.findOne({ email: normalizedEmail });

    // generic response — never reveal whether email exists
    if (!pendingUser) {
      return res.status(200).json({ message: "If a pending registration exists, a new OTP has been sent." });
    }

    const currentResendCount = pendingUser.resendCount;

    if (currentResendCount >= 5) {
      if (pendingUser.otpExhausted) {
        const now = new Date();
        const expiresAt = pendingUser.otpExpiresAt;

        if (expiresAt && expiresAt > now) {
          // OTP deleted by max attempts and wait time not over — tell user how long to wait
          const secondsLeft = Math.ceil((expiresAt - now) / 1000);
          const minutesLeft = Math.ceil(secondsLeft / 60);
          return res.status(429).json({
            message: `Maximum resend attempts reached. Please wait ${minutesLeft} minute(s) until the OTP expires.`,
            retryAfter: secondsLeft
          });
        }

        // otpExpiresAt has passed — treat as natural expiry, reset everything
        await createOtp(normalizedEmail, "signup", 1);
        await PendingUser.findByIdAndUpdate(pendingUser._id, {
          resendCount: 1,
          otpExhausted: false,
          otpExpiresAt: new Date(Date.now() + OTP_EXPIRY_MS)
        });
        return res.status(200).json({ message: "OTP resent successfully." });
      }

      // resendCount >= 5 but not exhausted — check if OTP still alive
      const existingOtp = await Otp.findOne({ identifier: normalizedEmail, purpose: "signup" });

      if (existingOtp) {
        // OTP still alive — block
        return res.status(429).json({ message: "Maximum resend attempts reached. Please wait until the OTP expires." });
      }

      // OTP expired naturally — reset and allow fresh start
      await createOtp(normalizedEmail, "signup", 1);
      await PendingUser.findByIdAndUpdate(pendingUser._id, {
        resendCount: 1,
        otpExhausted: false,
        otpExpiresAt: new Date(Date.now() + OTP_EXPIRY_MS)
      });
      return res.status(200).json({ message: "OTP resent successfully." });
    }

    try {
      await resendOtp(normalizedEmail, "signup");
      // OTP exists and resend succeeded — sync count and expiry to PendingUser
      await PendingUser.findByIdAndUpdate(pendingUser._id, {
        $inc: { resendCount: 1 },
        otpExpiresAt: new Date(Date.now() + OTP_EXPIRY_MS)
      });

    } catch (resendError) {

      if (resendError.message === "RESEND_LIMIT_REACHED") {
        return res.status(429).json({ message: "Maximum resend attempts reached. Please wait until the OTP expires." });
      }

      if (resendError.message === "COOLDOWN_ACTIVE") {
        return res.status(429).json({ message: "Please wait 60 seconds before requesting another OTP." });
      }

      if (resendError.message === "OTP_EXPIRED") {
        // OTP deleted due to max attempts — carry count and expiry forward
        await createOtp(normalizedEmail, "signup", currentResendCount + 1);
        await PendingUser.findByIdAndUpdate(pendingUser._id, {
          $inc: { resendCount: 1 },
          otpExpiresAt: new Date(Date.now() + OTP_EXPIRY_MS)
        });
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