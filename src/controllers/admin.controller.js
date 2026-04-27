const { User } = require("../models/user");
const Feedback = require("../models/Feedback");
const bcrypt = require("bcryptjs");
const { generateAccessToken, generateRefreshToken } = require("../utils/token");
const hashToken = require("../utils/hashToken");
const { NotificationTemplate } = require("../models/NotificationTemplate");

// Helper — user is online if pinged within last 60 seconds
const ONLINE_THRESHOLD_MS = 60 * 1000;
const isOnline = (lastActiveAt) =>
  lastActiveAt && (Date.now() - new Date(lastActiveAt).getTime()) < ONLINE_THRESHOLD_MS;

// GET /api/admin/stats
const getStats = async (req, res) => {
  try {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const totalUsers           = await User.countDocuments({ role: "user" });
    const bannedUsers          = await User.countDocuments({ role: "user", isBanned: true });
    const premiumUsers         = await User.countDocuments({ role: "user", isPremium: true });
    const totalAdmins          = await User.countDocuments({ role: { $in: ["admin", "superadmin"] } });
    const totalFeedbacks       = await Feedback.countDocuments();
    const scheduledForDeletion = await User.countDocuments({ role: "user", scheduledDeletionAt: { $ne: null } });
    const newUsersThisMonth    = await User.countDocuments({ role: "user", createdAt: { $gte: startOfMonth } });

    // Calculate average user rating from User collection
    const userRatingResult = await User.aggregate([
      { $match: { role: "user", rating: { $ne: null } } },
      { $group: { _id: null, avgUserRating: { $avg: "$rating" } } },
    ]);

    const avgUserRating = userRatingResult.length > 0
      ? parseFloat(userRatingResult[0].avgUserRating.toFixed(1))
      : null;

    return res.status(200).json({
      success: true,
      data: {
        totalUsers,
        newUsersThisMonth,
        bannedUsers,
        premiumUsers,
        totalAdmins,
        totalFeedbacks,
        scheduledForDeletion,
        avgUserRating,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// GET /api/admin/profile
const getAdminProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("-password -refreshToken");

    if (!user) {
      return res.status(404).json({ success: false, message: "Admin not found" });
    }

    return res.status(200).json({ success: true, data: user });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// PATCH /api/admin/profile
const updateAdminProfile = async (req, res) => {
  try {
    const { name, email } = req.body;

    const updates = {};
    if (name && name.trim()) updates.name = name.trim();
    if (email && email.trim()) updates.email = email.trim().toLowerCase();

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, message: "Nothing to update" });
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      updates,
      { new: true, runValidators: true }
    ).select("-password -refreshToken");

    if (!user) {
      return res.status(404).json({ success: false, message: "Admin not found" });
    }

    return res.status(200).json({ success: true, message: "Profile updated successfully", data: user });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: "Email already in use" });
    }
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// PATCH /api/admin/change-password
const changeAdminPassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: "Current and new password are required" });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, message: "Password must be at least 8 characters" });
    }

    const user = await User.findById(req.user._id).select("+password");
    if (!user) {
      return res.status(404).json({ success: false, message: "Admin not found" });
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: "Current password is incorrect" });
    }

    const isSame = await bcrypt.compare(newPassword, user.password);
    if (isSame) {
      return res.status(400).json({ success: false, message: "New password must be different from current password" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    const accessToken  = generateAccessToken(user._id, user.role);
    const refreshToken = generateRefreshToken(user._id);

    await User.findByIdAndUpdate(req.user._id, {
      password:     hashedPassword,
      refreshToken: hashToken(refreshToken),
    });

    return res.status(200).json({
      success: true,
      message: "Password changed successfully.",
      accessToken,
      refreshToken,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// POST /api/admin/logout-all
const logoutAllAdminSessions = async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user._id, { refreshToken: null });
    return res.status(200).json({ success: true, message: "All sessions invalidated successfully" });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// GET /api/admin/users
const getAllUsers = async (req, res) => {
  try {
    const users = await User.find({
      role: { $in: ["user", "admin"] },
    })
      .select("-password -refreshToken")
      .sort({ createdAt: -1 });

    const data = users.map((u) => ({ ...u.toObject(), isOnline: isOnline(u.lastActiveAt) }));

    return res.status(200).json({
      success: true,
      count: data.length,
      data,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// GET /api/admin/users/:id
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

// GET /api/admin/users/scheduled-deletion
const getScheduledDeletionUsers = async (req, res) => {
  try {
    const users = await User.find({
      role: "user",
      scheduledDeletionAt: { $ne: null },
    })
      .select("-password -refreshToken")
      .sort({ scheduledDeletionAt: 1 });

    return res.status(200).json({
      success: true,
      count: users.length,
      data: users,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// PATCH /api/admin/users/:id/ban
const banUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

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

// PATCH /api/admin/users/:id/unban
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

// POST /api/admin/users/:id/logout
const logoutUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

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

// PATCH /api/admin/users/:id/restore
const restoreUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

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

// GET /api/admin/analytics/users
// Query params: ?months=N (default: 6)
const getUserAnalytics = async (req, res) => {
  try {
    const Goal    = require("../models/goal");
    const Ledger  = require("../models/Ledger");
    const Account = require("../models/Account");

    const months = parseInt(req.query.months) || 6;
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - months);

    const userGrowth = await User.aggregate([
      {
        $match: {
          role: { $in: ["user", "admin"] },
          createdAt: { $gte: startDate },
        },
      },
      {
        $group: {
          _id: { month: { $month: "$createdAt" }, year: { $year: "$createdAt" } },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } },
    ]);

    const premiumUsers = await User.countDocuments({ role: "user", isPremium: true });
    const freeUsers    = await User.countDocuments({ role: "user", isPremium: false });

    // Build a set of valid non-banned user IDs (all roles — user + admin can
    // both use the app). Filtering Goal/Ledger/Account distinct results against
    // this set means ghost records from deleted dev/test accounts never inflate
    // the numerator above the denominator, so rates can never exceed 100%.
    const validUserIds   = await User.distinct("_id", { isBanned: false });
    const validIdStrings = new Set(validUserIds.map((id) => id.toString()));
    const eligibleCount  = validUserIds.length;

    const usersWithGoals = await Goal.distinct("userId");

    const usersWithTransactions = await Ledger.distinct("userId", {
      status: "COMPLETED",
      direction: "STANDARD",
    });

    // For multi-account we need the raw list (not a count) so we can filter
    const multiAccountRaw = await Account.aggregate([
      { $match: { deletedAt: null } },
      { $group: { _id: "$userId", count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ]);

    const goalAdoptionRate = eligibleCount
      ? parseFloat(((usersWithGoals.filter((id) => validIdStrings.has(id.toString())).length / eligibleCount) * 100).toFixed(1))
      : 0;

    const txAdoptionRate = eligibleCount
      ? parseFloat(((usersWithTransactions.filter((id) => validIdStrings.has(id.toString())).length / eligibleCount) * 100).toFixed(1))
      : 0;

    const multiAccountRate = eligibleCount
      ? parseFloat(((multiAccountRaw.filter((d) => validIdStrings.has(d._id.toString())).length / eligibleCount) * 100).toFixed(1))
      : 0;

    return res.status(200).json({
      success: true,
      data: {
        userGrowth,
        premiumVsFree: { premiumUsers, freeUsers },
        // ── NEW ──
        adoption: {
          goalAdoptionRate,
          txAdoptionRate,
          multiAccountRate,
        },
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// GET /api/admin/analytics/feedback
const getFeedbackAnalytics = async (req, res) => {
  try {
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const totalFeedbacksThisMonth = await Feedback.countDocuments({
      createdAt: { $gte: startOfMonth },
    });

    const feedbackByCategory = await Feedback.aggregate([
      { $group: { _id: "$category", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    const feedbackPerMonth = await Feedback.aggregate([
      { $match: { createdAt: { $gte: sixMonthsAgo } } },
      {
        $group: {
          _id: { month: { $month: "$createdAt" }, year: { $year: "$createdAt" } },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } },
    ]);

    const ratingResult = await Feedback.aggregate([
      { $match: { rating: { $ne: null } } },
      { $group: { _id: null, avgRating: { $avg: "$rating" } } },
    ]);

    const avgRating = ratingResult.length > 0
      ? parseFloat(ratingResult[0].avgRating.toFixed(1))
      : null;

    return res.status(200).json({
      success: true,
      data: {
        totalFeedbacksThisMonth,
        feedbackByCategory,
        feedbackPerMonth,
        avgRating,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// GET /api/admin/feedback
const getAllFeedback = async (req, res) => {
  try {
    const feedbacks = await Feedback.find()
      .populate("userId", "name email isEmailVerified isBanned")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: feedbacks.length,
      data: feedbacks,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// GET /api/admin/feedback/:id
const getFeedbackById = async (req, res) => {
  try {
    const feedback = await Feedback.findById(req.params.id)
      .populate("userId", "name email isEmailVerified isBanned");

    if (!feedback) {
      return res.status(404).json({ success: false, message: "Feedback not found" });
    }

    return res.status(200).json({ success: true, data: feedback });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// DELETE /api/admin/feedback/:id
const deleteFeedback = async (req, res) => {
  try {
    const feedback = await Feedback.findById(req.params.id);

    if (!feedback) {
      return res.status(404).json({ success: false, message: "Feedback not found" });
    }

    await feedback.deleteOne();

    return res.status(200).json({ success: true, message: "Feedback deleted successfully" });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// GET /api/admin/analytics/transactions
const getTransactionAnalytics = async (req, res) => {
  try {
    const Ledger = require("../models/Ledger");
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    // Income vs Expense totals — kept for reference but amounts not shown on analytics page
    const incomeExpense = await Ledger.aggregate([
      {
        $match: {
          status: "COMPLETED",
          transactionType: { $in: ["INCOME", "EXPENSE"] },
          direction: "STANDARD",
        },
      },
      {
        $group: {
          _id: "$transactionType",
          total: { $sum: { $toDouble: "$amount" } },
          count: { $sum: 1 },
        },
      },
    ]);

    const monthlyVolume = await Ledger.aggregate([
      {
        $match: {
          status: "COMPLETED",
          transactedAt: { $gte: sixMonthsAgo },
          direction: "STANDARD",
        },
      },
      {
        $group: {
          _id: {
            month: { $month: "$transactedAt" },
            year:  { $year: "$transactedAt" },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } },
    ]);

    // ── CHANGED: sort by count (frequency) not by total amount ────────
    const topCategories = await Ledger.aggregate([
      {
        $match: {
          status: "COMPLETED",
          transactionType: "EXPENSE",
          direction: "STANDARD",
        },
      },
      {
        $group: {
          _id: "$category",
          count: { $sum: 1 },
          // total kept in DB but not sent to frontend analytics
        },
      },
      { $sort: { count: -1 } },   // ← sorted by frequency now
      { $limit: 6 },
    ]);

    const totalTransactions = await Ledger.countDocuments({
      status: "COMPLETED",
      direction: "STANDARD",
    });

    const incomeData  = incomeExpense.find((d) => d._id === "INCOME")  || { total: 0, count: 0 };
    const expenseData = incomeExpense.find((d) => d._id === "EXPENSE") || { total: 0, count: 0 };

    return res.status(200).json({
      success: true,
      data: {
        totalTransactions,
        // Counts — shown on analytics/dashboard
        incomeCount:  incomeData.count,
        expenseCount: expenseData.count,
        // Monthly volume trend
        monthlyVolume,
        // Top categories by frequency (count only, no amounts)
        topCategories,
      },
    });
  } catch (error) {
    console.error("getTransactionAnalytics error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// GET /api/admin/analytics/goals
const getGoalAnalytics = async (req, res) => {
  try {
    const Goal = require("../models/goal");

    const goalsByStatus = await Goal.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);

    const goalsByCategory = await Goal.aggregate([
      {
        $group: {
          _id: "$category",
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ]);

    const completionData = await Goal.aggregate([
      {
        $project: {
          completionRate: {
            $multiply: [{ $divide: ["$currentAmount", "$targetAmount"] }, 100],
          },
        },
      },
      {
        $group: {
          _id: null,
          avgCompletionRate: { $avg: "$completionRate" },
          totalGoals:        { $sum: 1 },
        },
      },
    ]);

    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    // ── Already existed in controller but was never returned — now returned ──
    const goalsPerMonth = await Goal.aggregate([
      { $match: { createdAt: { $gte: sixMonthsAgo } } },
      {
        $group: {
          _id: { month: { $month: "$createdAt" }, year: { $year: "$createdAt" } },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } },
    ]);

    const stats     = completionData[0] || { avgCompletionRate: 0, totalGoals: 0 };
    const active    = goalsByStatus.find((d) => d._id === "active")    || { count: 0 };
    const completed = goalsByStatus.find((d) => d._id === "completed") || { count: 0 };
    const overdue   = goalsByStatus.find((d) => d._id === "overdue")   || { count: 0 };

    return res.status(200).json({
      success: true,
      data: {
        totalGoals:        stats.totalGoals,
        activeGoals:       active.count,
        completedGoals:    completed.count,
        overdueGoals:      overdue.count,
        avgCompletionRate: parseFloat((stats.avgCompletionRate || 0).toFixed(1)),
        // ── CHANGED: category data is count only (no rupee amounts) ──
        goalsByCategory,
        // ── NEW: was computed before but never returned ──────────────
        goalsPerMonth,
      },
    });
  } catch (error) {
    console.error("getGoalAnalytics error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// GET /api/admin/analytics/accounts
const getAccountAnalytics = async (req, res) => {
  try {
    const Account = require("../models/Account");

    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const accountsByType = await Account.aggregate([
      { $match: { deletedAt: null } },
      {
        $group: {
          _id: "$type",
          count: { $sum: 1 },
        },
      },
    ]);

    const accountsByStatus = await Account.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);

    const countData = await Account.aggregate([
      { $match: { status: "ACTIVE", deletedAt: null } },
      {
        $group: {
          _id: null,
          totalAccounts: { $sum: 1 },
        },
      },
    ]);

    const avgAccountsPerUser = await Account.aggregate([
      { $match: { deletedAt: null } },
      { $group: { _id: "$userId", accountCount: { $sum: 1 } } },
      { $group: { _id: null, avgAccounts: { $avg: "$accountCount" } } },
    ]);

    // ── NEW: Accounts created per month trend ──────────────────────────
    const accountsPerMonth = await Account.aggregate([
      { $match: { deletedAt: null, createdAt: { $gte: sixMonthsAgo } } },
      {
        $group: {
          _id: { month: { $month: "$createdAt" }, year: { $year: "$createdAt" } },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } },
    ]);

    const counts   = countData[0] || { totalAccounts: 0 };
    const cashData = accountsByType.find((d) => d._id === "CASH") || { count: 0 };
    const bankData = accountsByType.find((d) => d._id === "BANK") || { count: 0 };
    const active   = accountsByStatus.find((d) => d._id === "ACTIVE") || { count: 0 };
    const frozen   = accountsByStatus.find((d) => d._id === "FROZEN") || { count: 0 };
    const closed   = accountsByStatus.find((d) => d._id === "CLOSED") || { count: 0 };

    return res.status(200).json({
      success: true,
      data: {
        totalAccounts:     counts.totalAccounts,
        avgAccountsPerUser: parseFloat((avgAccountsPerUser[0]?.avgAccounts || 0).toFixed(1)),
        cashAccounts:      cashData.count,
        bankAccounts:      bankData.count,
        activeAccounts:    active.count,
        frozenAccounts:    frozen.count,
        closedAccounts:    closed.count,
        // ── NEW ──────────────────────────────────────────────────────
        accountsPerMonth,
        // ── REMOVED: totalBalance, cashBalance, bankBalance, avgBalance ──
      },
    });
  } catch (error) {
    console.error("getAccountAnalytics error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// GET /api/admin/users/:id/overview
// Note: Per-user rupee amounts are kept here — they're meaningful for a single user's detail view
const getUserOverview = async (req, res) => {
  try {
    const Account = require("../models/Account");
    const Goal    = require("../models/goal");
    const Ledger  = require("../models/Ledger");
    const userId  = req.params.id;
    const { User } = require("../models/user");

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const mongoose = require("mongoose");
    const userObjectId = new mongoose.Types.ObjectId(userId);

    const accountStats = await Account.aggregate([
      { $match: { userId: userObjectId } },
      {
        $group: {
          _id: null,
          total:        { $sum: 1 },
          active:       { $sum: { $cond: [{ $eq: ["$status", "ACTIVE"] }, 1, 0] } },
          frozen:       { $sum: { $cond: [{ $eq: ["$status", "FROZEN"] }, 1, 0] } },
          closed:       { $sum: { $cond: [{ $eq: ["$status", "CLOSED"] }, 1, 0] } },
          cashAccounts: { $sum: { $cond: [{ $eq: ["$type",   "CASH"]   }, 1, 0] } },
          bankAccounts: { $sum: { $cond: [{ $eq: ["$type",   "BANK"]   }, 1, 0] } },
          totalBalance: { $sum: { $toDouble: "$availableBalance" } },
        },
      },
    ]);

    const goalStats = await Goal.aggregate([
      { $match: { userId: userObjectId } },
      {
        $group: {
          _id: null,
          total:              { $sum: 1 },
          active:             { $sum: { $cond: [{ $eq: ["$status", "active"]    }, 1, 0] } },
          completed:          { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
          overdue:            { $sum: { $cond: [{ $eq: ["$status", "overdue"]   }, 1, 0] } },
          totalTargetAmount:  { $sum: "$targetAmount" },
          totalCurrentAmount: { $sum: "$currentAmount" },
        },
      },
    ]);

    const txStats = await Ledger.aggregate([
      {
        $match: {
          userId: userObjectId,
          status: "COMPLETED",
          direction: "STANDARD",
        },
      },
      {
        $group: {
          _id: null,
          total:        { $sum: 1 },
          totalIncome:  { $sum: { $cond: [{ $eq: ["$transactionType", "INCOME"]  }, { $toDouble: "$amount" }, 0] } },
          totalExpense: { $sum: { $cond: [{ $eq: ["$transactionType", "EXPENSE"] }, { $toDouble: "$amount" }, 0] } },
        },
      },
    ]);

    const topCategory = await Ledger.aggregate([
      {
        $match: {
          userId: userObjectId,
          status: "COMPLETED",
          transactionType: "EXPENSE",
          direction: "STANDARD",
        },
      },
      { $group: { _id: "$category", total: { $sum: { $toDouble: "$amount" } } } },
      { $sort: { total: -1 } },
      { $limit: 1 },
    ]);

    const accounts     = accountStats[0] || { total: 0, active: 0, frozen: 0, closed: 0, cashAccounts: 0, bankAccounts: 0, totalBalance: 0 };
    const goals        = goalStats[0]    || { total: 0, active: 0, completed: 0, overdue: 0, totalTargetAmount: 0, totalCurrentAmount: 0 };
    const transactions = txStats[0]      || { total: 0, totalIncome: 0, totalExpense: 0 };

    const avgCompletionRate = goals.total > 0
      ? parseFloat(((goals.totalCurrentAmount / goals.totalTargetAmount) * 100 || 0).toFixed(1))
      : 0;

    return res.status(200).json({
      success: true,
      data: {
        accounts: {
          total:        accounts.total,
          active:       accounts.active,
          frozen:       accounts.frozen,
          closed:       accounts.closed,
          cashAccounts: accounts.cashAccounts,
          bankAccounts: accounts.bankAccounts,
          totalBalance: parseFloat(accounts.totalBalance.toFixed(2)),
        },
        goals: {
          total:              goals.total,
          active:             goals.active,
          completed:          goals.completed,
          overdue:            goals.overdue,
          totalTargetAmount:  parseFloat(goals.totalTargetAmount.toFixed(2)),
          totalCurrentAmount: parseFloat(goals.totalCurrentAmount.toFixed(2)),
          avgCompletionRate,
        },
        transactions: {
          total:        transactions.total,
          totalIncome:  parseFloat(transactions.totalIncome.toFixed(2)),
          totalExpense: parseFloat(transactions.totalExpense.toFixed(2)),
          topCategory:  topCategory[0]?._id || "—",
        },
      },
    });
  } catch (error) {
    console.error("getUserOverview error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// PATCH /api/admin/heartbeat
const heartbeat = async (req, res) => {
  try {
    await require("../models/user").User.findByIdAndUpdate(req.user._id, {
      lastActiveAt: new Date(),
    });
    return res.status(200).json({ success: true });
  } catch {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// ========== SUPERADMIN ONLY FUNCTIONS ==========

// POST /api/admin/create-admin
const createAdmin = async (req, res) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({
        success: false,
        message: "Email, password, and name are required",
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 8 characters",
      });
    }

    const existingUser = await User.findOne({ email: email.trim().toLowerCase() });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: "Email already registered",
      });
    }

    const newAdmin = new User({
      email: email.trim().toLowerCase(),
      password,
      name: name.trim(),
      role: "admin",
      isEmailVerified: true,
    });

    await newAdmin.save();

    const Account = require("../models/Account");
    const newAccount = new Account({
      userId:    newAdmin._id,
      name:      "Main Wallet",
      type:      "CASH",
      currency:  "INR",
      isDefault: true,
      status:    "ACTIVE",
    });

    await newAccount.save();

    const adminData = await User.findById(newAdmin._id).select("-password -refreshToken");

    return res.status(201).json({
      success: true,
      message: "Admin created successfully",
      data: adminData,
    });
  } catch (error) {
    console.error("createAdmin error:", error);
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: "Email already exists" });
    }
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// GET /api/admin/admins
const getAllAdmins = async (req, res) => {
  try {
    const admins = await User.find({
      role: { $in: ["admin", "superadmin"] },
    })
      .select("-password -refreshToken")
      .sort({ createdAt: -1 });

    const data = admins.map((a) => ({ ...a.toObject(), isOnline: isOnline(a.lastActiveAt) }));

    return res.status(200).json({
      success: true,
      count: data.length,
      data,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// PATCH /api/admin/demote/:id
const demoteAdmin = async (req, res) => {
  try {
    const targetUser = await User.findById(req.params.id);

    if (!targetUser) {
      return res.status(404).json({ success: false, message: "Admin not found" });
    }

    if (targetUser.role === "superadmin") {
      return res.status(400).json({ success: false, message: "Cannot demote a superadmin" });
    }

    if (targetUser._id.toString() === req.user._id.toString()) {
      return res.status(400).json({ success: false, message: "Cannot demote yourself" });
    }

    if (targetUser.role !== "admin") {
      return res.status(400).json({ success: false, message: "User is not an admin" });
    }

    targetUser.role = "user";
    await targetUser.save();

    return res.status(200).json({ success: true, message: "Admin demoted to user successfully" });
  } catch (error) {
    console.error("demoteAdmin error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// DELETE /api/admin/delete/:id
const deleteAdmin = async (req, res) => {
  try {
    const targetUser = await User.findById(req.params.id);

    if (!targetUser) {
      return res.status(404).json({ success: false, message: "Admin not found" });
    }

    if (targetUser.role === "superadmin") {
      return res.status(400).json({ success: false, message: "Cannot delete a superadmin" });
    }

    if (targetUser._id.toString() === req.user._id.toString()) {
      return res.status(400).json({ success: false, message: "Cannot delete yourself" });
    }

    if (targetUser.role !== "admin") {
      return res.status(400).json({ success: false, message: "User is not an admin" });
    }

    const Account = require("../models/Account");
    const Goal    = require("../models/goal");
    const Ledger  = require("../models/Ledger");

    await Account.deleteMany({ userId: targetUser._id });
    await Goal.deleteMany({ userId: targetUser._id });
    await Ledger.deleteMany({ userId: targetUser._id });
    await User.findByIdAndDelete(targetUser._id);

    return res.status(200).json({ success: true, message: "Admin deleted successfully" });
  } catch (error) {
    console.error("deleteAdmin error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const adminNotificationService = require("../services/adminNotification.service");

// ================= SEND TO USER =================
const sendNotificationToUser = async (req, res) => {
  try {
    const { userId, message, title } = req.body;
    await adminNotificationService.sendToUser(userId, message, title);
    return res.status(200).json({ success: true, message: "Notification sent successfully" });
  } catch (error) {
    console.error("sendNotificationToUser error:", error.message);
    return res.status(400).json({ success: false, message: error.message });
  }
};

// ================= BROADCAST =================
const broadcastNotification = async (req, res) => {
  try {
    const { message, title } = req.body;
    const filter = req.query.filter;
    const result = await adminNotificationService.broadcast(filter, message, title);
    return res.status(200).json({ success: true, message: "Broadcast completed", data: result });
  } catch (error) {
    console.error("broadcastNotification error:", error.message);
    return res.status(400).json({ success: false, message: error.message });
  }
};

// ================= SEND TO ADMIN =================
const sendNotificationToAdmin = async (req, res) => {
  try {
    const { adminId, message, title } = req.body;
    await adminNotificationService.sendToAdmin(adminId, message, title);
    return res.status(200).json({ success: true, message: "Notification sent to admin" });
  } catch (error) {
    console.error("sendNotificationToAdmin error:", error.message);
    return res.status(400).json({ success: false, message: error.message });
  }
};

// ================= BROADCAST TO ADMINS =================
const broadcastToAdmins = async (req, res) => {
  try {
    const { message, title } = req.body;
    const result = await adminNotificationService.broadcastAdmins(message, title);
    return res.status(200).json({ success: true, message: "Admin broadcast completed", data: result });
  } catch (error) {
    console.error("broadcastToAdmins error:", error.message);
    return res.status(400).json({ success: false, message: error.message });
  }
};

// ================= NOTIFICATION TEMPLATES =================

const getNotificationTemplates = async (req, res) => {
  try {
    const templates = await NotificationTemplate.find()
      .sort({ createdAt: -1 })
      .lean();
    return res.status(200).json({ success: true, count: templates.length, data: templates });
  } catch (error) {
    console.error("getNotificationTemplates error:", error.message);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const createNotificationTemplate = async (req, res) => {
  try {
    const { title, message, filter } = req.body;
    if (!title?.trim() || !message?.trim())
      return res.status(400).json({ success: false, message: "Title and message are required" });
    if (message.trim().length > 255)
      return res.status(400).json({ success: false, message: "Message cannot exceed 255 characters" });
    if (title.trim().length > 100)
      return res.status(400).json({ success: false, message: "Title cannot exceed 100 characters" });

    const template = await NotificationTemplate.create({
      title:         title.trim(),
      message:       message.trim(),
      filter:        filter || "active",
      createdBy:     req.user._id,
      createdByName: req.user.name || "",
    });
    return res.status(201).json({ success: true, message: "Template created successfully", data: template });
  } catch (error) {
    console.error("createNotificationTemplate error:", error.message);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const deleteNotificationTemplate = async (req, res) => {
  try {
    const template = await NotificationTemplate.findByIdAndDelete(req.params.id);
    if (!template)
      return res.status(404).json({ success: false, message: "Template not found" });
    return res.status(200).json({ success: true, message: "Template deleted successfully" });
  } catch (error) {
    console.error("deleteNotificationTemplate error:", error.message);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const broadcastNotificationTemplate = async (req, res) => {
  try {
    const template = await NotificationTemplate.findById(req.params.id);
    if (!template)
      return res.status(404).json({ success: false, message: "Template not found" });

    // filter can come from body, query, or fall back to the template's own saved filter
    const filter = req.body?.filter || req.query?.filter || template.filter;

    const result = await adminNotificationService.broadcast(filter, template.message, template.title);

    await NotificationTemplate.findByIdAndUpdate(req.params.id, {
      $inc: { broadcastCount: 1 },
      lastBroadcastAt:     new Date(),
      lastBroadcastResult: result,
    });

    return res.status(200).json({ success: true, message: "Broadcast completed", data: result });
  } catch (error) {
    console.error("broadcastNotificationTemplate error:", error.message);
    return res.status(400).json({ success: false, message: error.message });
  }
};

module.exports = {
  getStats,
  getAdminProfile,
  updateAdminProfile,
  changeAdminPassword,
  logoutAllAdminSessions,
  getAllUsers,
  getUserById,
  getScheduledDeletionUsers,
  banUser,
  unbanUser,
  logoutUser,
  restoreUser,
  getUserAnalytics,
  getFeedbackAnalytics,
  getAllFeedback,
  getFeedbackById,
  deleteFeedback,
  getTransactionAnalytics,
  getGoalAnalytics,
  getAccountAnalytics,
  getUserOverview,
  sendNotificationToUser,
  broadcastNotification,
  sendNotificationToAdmin,
  // Superadmin functions
  broadcastToAdmins,
  createAdmin,
  getAllAdmins,
  demoteAdmin,
  deleteAdmin,
  heartbeat,
// ── Notification Templates ──
  getNotificationTemplates,
  createNotificationTemplate,
  deleteNotificationTemplate,
  broadcastNotificationTemplate,
};