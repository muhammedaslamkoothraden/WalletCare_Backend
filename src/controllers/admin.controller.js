const { User } = require("../models/user");
const Feedback = require("../models/Feedback");

// GET /api/admin/stats
const getStats = async (req, res) => {
  try {
    const totalUsers = await User.countDocuments({ role: "user" });
    const bannedUsers = await User.countDocuments({ role: "user", isBanned: true });
    const activeUsers = totalUsers - bannedUsers;
    const premiumUsers = await User.countDocuments({ role: "user", isPremium: true });
    const totalFeedbacks = await Feedback.countDocuments();
    const scheduledForDeletion = await User.countDocuments({
      role: "user",
      scheduledDeletionAt: { $ne: null },
    });

    return res.status(200).json({
      success: true,
      data: {
        totalUsers,
        activeUsers,
        bannedUsers,
        premiumUsers,
        totalFeedbacks,
        scheduledForDeletion,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// GET /api/admin/users
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
const getUserAnalytics = async (req, res) => {
  try {
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    // Monthly user registrations (last 6 months)
    const userGrowth = await User.aggregate([
      {
        $match: {
          role: "user",
          createdAt: { $gte: sixMonthsAgo },
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

    // Premium vs Free users
    const premiumUsers = await User.countDocuments({ role: "user", isPremium: true });
    const freeUsers = await User.countDocuments({ role: "user", isPremium: false });

    return res.status(200).json({
      success: true,
      data: {
        userGrowth,
        premiumVsFree: { premiumUsers, freeUsers },
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

    // Total feedbacks this month
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const totalFeedbacksThisMonth = await Feedback.countDocuments({
      createdAt: { $gte: startOfMonth },
    });

    // Feedback by category
    const feedbackByCategory = await Feedback.aggregate([
      { $group: { _id: "$category", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    // Feedback per month (last 6 months)
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

    // Average rating
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
      .populate("userId", "name email")
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
      .populate("userId", "name email");

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

    // Total income vs expense
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

    // Monthly transaction volume (last 6 months)
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
            year: { $year: "$transactedAt" },
          },
          count: { $sum: 1 },
          totalAmount: { $sum: { $toDouble: "$amount" } },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } },
    ]);

    // Top spending categories
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
          total: { $sum: { $toDouble: "$amount" } },
          count: { $sum: 1 },
        },
      },
      { $sort: { total: -1 } },
      { $limit: 6 },
    ]);

    // Total transaction count
    const totalTransactions = await Ledger.countDocuments({
      status: "COMPLETED",
      direction: "STANDARD",
    });

    // Format income/expense
    const incomeData = incomeExpense.find((d) => d._id === "INCOME") || { total: 0, count: 0 };
    const expenseData = incomeExpense.find((d) => d._id === "EXPENSE") || { total: 0, count: 0 };

    return res.status(200).json({
      success: true,
      data: {
        totalTransactions,
        totalIncome: parseFloat(incomeData.total.toFixed(2)),
        totalExpense: parseFloat(expenseData.total.toFixed(2)),
        incomeCount: incomeData.count,
        expenseCount: expenseData.count,
        monthlyVolume,
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

    // Goals by status
    const goalsByStatus = await Goal.aggregate([
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
        },
      },
    ]);

    // Goals by category
    const goalsByCategory = await Goal.aggregate([
      {
        $group: {
          _id: "$category",
          count: { $sum: 1 },
          totalTarget: { $sum: "$targetAmount" },
          totalCurrent: { $sum: "$currentAmount" },
        },
      },
      { $sort: { count: -1 } },
    ]);

    // Average completion rate
    const completionData = await Goal.aggregate([
      {
        $project: {
          completionRate: {
            $multiply: [
              { $divide: ["$currentAmount", "$targetAmount"] },
              100,
            ],
          },
        },
      },
      {
        $group: {
          _id: null,
          avgCompletionRate: { $avg: "$completionRate" },
          totalGoals: { $sum: 1 },
          totalTargetAmount: { $sum: "$targetAmount" },
          totalCurrentAmount: { $sum: "$currentAmount" },
        },
      },
    ]);

    // Goals created per month (last 6 months)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const goalsPerMonth = await Goal.aggregate([
      { $match: { createdAt: { $gte: sixMonthsAgo } } },
      {
        $group: {
          _id: {
            month: { $month: "$createdAt" },
            year: { $year: "$createdAt" },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } },
    ]);

    const stats = completionData[0] || {
      avgCompletionRate: 0,
      totalGoals: 0,
      totalTargetAmount: 0,
      totalCurrentAmount: 0,
    };

    // Format status counts
    const active = goalsByStatus.find((d) => d._id === "active") || { count: 0 };
    const completed = goalsByStatus.find((d) => d._id === "completed") || { count: 0 };
    const overdue = goalsByStatus.find((d) => d._id === "overdue") || { count: 0 };

    return res.status(200).json({
      success: true,
      data: {
        totalGoals: stats.totalGoals,
        activeGoals: active.count,
        completedGoals: completed.count,
        overdueGoals: overdue.count,
        avgCompletionRate: parseFloat((stats.avgCompletionRate || 0).toFixed(1)),
        totalTargetAmount: parseFloat(
          goalsByCategory.reduce((sum, d) => sum + d.totalTarget, 0).toFixed(2)
        ),
        totalCurrentAmount: parseFloat(
          goalsByCategory.reduce((sum, d) => sum + d.totalCurrent, 0).toFixed(2)
        ),
        goalsByCategory,
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

    // Accounts by type
    const accountsByType = await Account.aggregate([
      { $match: { deletedAt: null } },
      {
        $group: {
          _id: "$type",
          count: { $sum: 1 },
          totalBalance: { $sum: { $toDouble: "$availableBalance" } },
        },
      },
    ]);

    // Accounts by status
    const accountsByStatus = await Account.aggregate([
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
        },
      },
    ]);

    // Total balance across all active accounts
    const balanceData = await Account.aggregate([
      {
        $match: {
          status: "ACTIVE",
          deletedAt: null,
        },
      },
      {
        $group: {
          _id: null,
          totalBalance: { $sum: { $toDouble: "$availableBalance" } },
          totalAccounts: { $sum: 1 },
          avgBalance: { $avg: { $toDouble: "$availableBalance" } },
        },
      },
    ]);

    // Average accounts per user
    const avgAccountsPerUser = await Account.aggregate([
      { $match: { deletedAt: null } },
      {
        $group: {
          _id: "$userId",
          accountCount: { $sum: 1 },
        },
      },
      {
        $group: {
          _id: null,
          avgAccounts: { $avg: "$accountCount" },
        },
      },
    ]);

    const balance = balanceData[0] || {
      totalBalance: 0,
      totalAccounts: 0,
      avgBalance: 0,
    };

    const cashData = accountsByType.find((d) => d._id === "CASH") || { count: 0, totalBalance: 0 };
    const bankData = accountsByType.find((d) => d._id === "BANK") || { count: 0, totalBalance: 0 };
    const active = accountsByStatus.find((d) => d._id === "ACTIVE") || { count: 0 };
    const frozen = accountsByStatus.find((d) => d._id === "FROZEN") || { count: 0 };
    const closed = accountsByStatus.find((d) => d._id === "CLOSED") || { count: 0 };

    return res.status(200).json({
      success: true,
      data: {
        totalAccounts: balance.totalAccounts,
        totalBalance: parseFloat(balance.totalBalance.toFixed(2)),
        avgBalance: parseFloat(balance.avgBalance.toFixed(2)),
        avgAccountsPerUser: parseFloat((avgAccountsPerUser[0]?.avgAccounts || 0).toFixed(1)),
        cashAccounts: cashData.count,
        bankAccounts: bankData.count,
        cashBalance: parseFloat(cashData.totalBalance.toFixed(2)),
        bankBalance: parseFloat(bankData.totalBalance.toFixed(2)),
        activeAccounts: active.count,
        frozenAccounts: frozen.count,
        closedAccounts: closed.count,
      },
    });
  } catch (error) {
    console.error("getAccountAnalytics error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

module.exports = {
  getStats,
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
};