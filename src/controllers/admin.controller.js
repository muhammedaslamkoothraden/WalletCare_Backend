const { User } = require("../models/user");
const Feedback = require("../models/Feedback");

const getStats = async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const bannedUsers = await User.countDocuments({ isBanned: true });
    const activeUsers = totalUsers - bannedUsers;
    const premiumUsers = await User.countDocuments({ isPremium: true });
    const totalFeedbacks = await Feedback.countDocuments();

    return res.status(200).json({
      success: true,
      data: {
        totalUsers,
        activeUsers,
        bannedUsers,
        premiumUsers,
        totalFeedbacks,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const getAllUsers = async (req, res) => {
    try {
    const users = await User.find({ role: "user" })
      .select("-password -refreshToken")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: users.length,
      data: users,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const getUserById = async (req, res) => {
    try {
    const user = await User.findById(req.params.id).select("-password -refreshToken");

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    return res.status(200).json({ success: true, data: user });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const banUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Prevent banning admins
    if (user.role === "admin") {
      return res.status(400).json({ success: false, message: "Cannot ban an admin" });
    }

    if (user.isBanned) {
      return res.status(400).json({ success: false, message: "User is already banned" });
    }

    user.isBanned = true;
    await user.save();

    return res.status(200).json({ success: true, message: "User banned successfully" });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const unbanUser = async (req, res) => {
    try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    if (!user.isBanned) {
      return res.status(400).json({ success: false, message: "User is not banned" });
    }

    user.isBanned = false;
    await user.save();

    return res.status(200).json({ success: true, message: "User unbanned successfully" });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const logoutUser = async (req, res) => {
    try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Prevent modifying admin accounts
    if (user.role === "admin") {
      return res.status(400).json({ success: false, message: "Cannot modify an admin account" });
    }

    user.refreshToken = null;
    await user.save();

    return res.status(200).json({ success: true, message: "User logged out successfully" });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const restoreUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Prevent restoring/modifying admin accounts
    if (user.role === "admin") {
      return res.status(400).json({ success: false, message: "Cannot modify an admin account" });
    }

    if (!user.scheduledDeletionAt) {
      return res.status(400).json({ success: false, message: "User is not scheduled for deletion" });
    }

    user.scheduledDeletionAt = null;
    await user.save();

    return res.status(200).json({ success: true, message: "User restored successfully" });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};


const getAnalytics = async (req, res) => {};

module.exports = {
  getStats,
  getAllUsers,
  getUserById,
  banUser,
  unbanUser,
  logoutUser,
  restoreUser,
  getAnalytics,
};