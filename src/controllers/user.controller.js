const { User, PendingUser } = require("../models/user");
const bcrypt = require("bcryptjs");
const { createOtp, resendOtp } = require("../services/otp.service");
const Otp = require("../models/otp");
const Account = require("../models/Account");
const Goal = require("../models/Goal");
const Ledger = require("../models/ledger");
const { verifyResetToken, generateAccessToken, generateRefreshToken } = require("../utils/token");
const hashToken = require("../utils/hashToken");

const DELETION_DAYS = 14;


// Get Profile
exports.getProfile = async (req, res) => {
  try {

    const user = await User.findById(req.user._id);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.status(200).json({
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        isPremium: user.isPremium,
        isEmailVerified: user.isEmailVerified,
        createdAt: user.createdAt,
        // include deletion date if scheduled — frontend can show warning banner
        scheduledDeletionAt: user.scheduledDeletionAt || null
      }
    });

  } catch (error) {
    console.error("getProfile error:", error.message);
    return res.status(500).json({ message: "Server error" });
  }
};


// Update Profile
exports.updateProfile = async (req, res) => {
  try {
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({ message: "Provide at least one field to update" });
    }

    const updates = {};
    if (name) updates.name = name.trim();

    const user = await User.findByIdAndUpdate(
      req.user._id,
      updates,
      { new: true, runValidators: true }
    );

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.status(200).json({
      message: "Profile updated successfully",
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        isPremium: user.isPremium,
        isEmailVerified: user.isEmailVerified,
        createdAt: user.createdAt
      }
    });

  } catch (error) {
    console.error("updateProfile error:", error.message);
    return res.status(500).json({ message: "Server error" });
  }
};


// Change Password — user knows current password
// generates new tokens — user stays logged in
exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: "Current and new password are required" });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ message: "New password must be at least 8 characters" });
    }

    const user = await User.findById(req.user._id).select("+password");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: "Current password is incorrect" });
    }

    const isSame = await bcrypt.compare(newPassword, user.password);
    if (isSame) {
      return res.status(400).json({ message: "New password must be different from current password" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // generate new tokens — user stays logged in
    const accessToken = generateAccessToken(user._id, user.role);
    const refreshToken = generateRefreshToken(user._id);

    await User.findByIdAndUpdate(req.user._id, {
      password: hashedPassword,
      refreshToken: hashToken(refreshToken)
    });

    return res.status(200).json({
      message: "Password changed successfully.",
      accessToken,
      refreshToken
    });

  } catch (error) {
    console.error("changePassword error:", error.message);
    return res.status(500).json({ message: "Server error" });
  }
};


// Forgot Password — inside app, user doesn't know current password
// email from token — no need to send in body
exports.forgotPassword = async (req, res) => {
  try {

    const email = req.user.email;

    const existingOtp = await Otp.findOne({ identifier: email, purpose: "reset_password" });

    if (existingOtp) {
      try {
        await resendOtp(email, "reset_password");
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
      await createOtp(email, "reset_password");
    }

    return res.status(200).json({ message: "OTP sent to your registered email." });

  } catch (error) {
    console.error("forgotPassword error:", error.message);
    return res.status(500).json({ message: "Server error" });
  }
};


// Reset Password — inside app, requires resetToken from /otp/verify/private
// generates new tokens — user stays logged in
exports.resetPassword = async (req, res) => {
  try {
    const { resetToken, newPassword } = req.body;

    if (!resetToken || !newPassword) {
      return res.status(400).json({ message: "Reset token and new password are required" });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    }

    let decoded;
    try {
      decoded = verifyResetToken(resetToken);
    } catch (err) {
      if (err.name === "TokenExpiredError") {
        return res.status(401).json({ message: "Reset token expired. Please verify OTP again." });
      }
      return res.status(401).json({ message: "Invalid reset token" });
    }

    if (decoded.purpose !== "reset_password") {
      return res.status(401).json({ message: "Invalid reset token" });
    }

    if (decoded.userId.toString() !== req.user._id.toString()) {
      return res.status(401).json({ message: "Invalid reset token" });
    }

    const user = await User.findById(req.user._id).select("+password");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const isSame = await bcrypt.compare(newPassword, user.password);
    if (isSame) {
      return res.status(400).json({ message: "New password must be different from current password" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // generate new tokens — user stays logged in
    const accessToken = generateAccessToken(user._id, user.role);
    const refreshToken = generateRefreshToken(user._id);

    await User.findByIdAndUpdate(req.user._id, {
      password: hashedPassword,
      refreshToken: hashToken(refreshToken)
    });

    return res.status(200).json({
      message: "Password reset successfully.",
      accessToken,
      refreshToken
    });

  } catch (error) {
    console.error("resetPassword error:", error.message);
    return res.status(500).json({ message: "Server error" });
  }
};


// Delete Account — soft delete, schedules permanent deletion after 14 days
exports.deleteAccount = async (req, res) => {
  try {
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({ message: "Password is required to delete account" });
    }

    const user = await User.findById(req.user._id).select("+password");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: "Incorrect password" });
    }

    // already scheduled — tell user when it will be deleted
    if (user.scheduledDeletionAt) {
      const daysLeft = Math.ceil((user.scheduledDeletionAt - new Date()) / (1000 * 60 * 60 * 24));
      return res.status(200).json({
        message: `Your account is already scheduled for deletion in ${daysLeft} day(s).`,
        scheduledDeletionAt: user.scheduledDeletionAt
      });
    }

    const scheduledDeletionAt = new Date(Date.now() + DELETION_DAYS * 24 * 60 * 60 * 1000);

    // null refreshToken — forces logout after current accessToken expires
    await User.findByIdAndUpdate(req.user._id, {
      scheduledDeletionAt,
      refreshToken: null
    });

    return res.status(200).json({
      message: `Account scheduled for deletion in ${DELETION_DAYS} days. Login anytime before then to cancel.`,
      scheduledDeletionAt
    });

  } catch (error) {
    console.error("deleteAccount error:", error.message);
    return res.status(500).json({ message: "Server error" });
  }
};


// Logout
exports.logoutUser = async (req, res) => {
  try {

    await User.findByIdAndUpdate(req.user._id, { refreshToken: null });

    return res.status(200).json({ message: "Logged out successfully" });

  } catch (error) {
    console.error("logoutUser error:", error.message);
    return res.status(500).json({ message: "Server error" });
  }
};