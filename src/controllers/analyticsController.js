const mongoose = require('mongoose');
const Ledger = require('../models/Ledger');
const Account = require('../models/Account');
const Goal = require('../models/Goal');

// ─── DASHBOARD ANALYTICS ──────────────────────────────────────────────────
exports.getAnalyticsDashboard = async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.id);
    
    const { accountId, timeframe = 'Month', month, year } = req.query;

    const now = new Date();
    let startDate;
    let endDate; 

    // Improved Date Calculation with Explicit End Dates
    if (month && year) {
      const m = parseInt(month, 10) - 1; 
      const y = parseInt(year, 10);
      startDate = new Date(y, m, 1, 0, 0, 0, 0);
      endDate = new Date(y, m + 1, 1, 0, 0, 0, 0); 
    } else {
      switch (timeframe.toLowerCase()) {
        case 'day':
          startDate = new Date();
          startDate.setHours(0, 0, 0, 0);
          endDate = new Date(startDate);
          endDate.setDate(endDate.getDate() + 1);
          break;
        case 'week':
          startDate = new Date();
          startDate.setDate(now.getDate() - now.getDay());
          startDate.setHours(0, 0, 0, 0);
          endDate = new Date(startDate);
          endDate.setDate(endDate.getDate() + 7);
          break;
        case 'year':
          startDate = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
          endDate = new Date(now.getFullYear() + 1, 0, 1, 0, 0, 0, 0);
          break;
        default: 
          startDate = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
          endDate = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
      }
    }

    const baseMatch = {
      userId,
      status: 'COMPLETED',
      transactedAt: { 
        $gte: startDate, 
        $lt: endDate 
      },
    };

    if (accountId && accountId !== 'all') {
      baseMatch.accountId = new mongoose.Types.ObjectId(accountId);
    }

    // Exclude Reversed Transactions and Their Parents
    const reversalScope = accountId && accountId !== 'all' 
       ? { userId, accountId: new mongoose.Types.ObjectId(accountId) } 
       : { userId };

    const reversals = await Ledger.find({ ...reversalScope, direction: 'REVERSAL' }).select('_id parentTransactionId').lean();
    const excludedIds = new Set();
    for (const r of reversals) {
      excludedIds.add(r._id.toString());
      if (r.parentTransactionId) excludedIds.add(r.parentTransactionId.toString());
    }

    if (excludedIds.size > 0) {
      baseMatch._id = { $nin: [...excludedIds].map((id) => new mongoose.Types.ObjectId(id)) };
    }

    // Run Aggregations
    const [cashflow, categorySpending, totalTransactions] = await Promise.all([
      Ledger.aggregate([
        { $match: baseMatch },
        {
          $group: {
            _id: '$transactionType',
            total: { $sum: { $convert: { input: '$amount', to: 'double', onError: 0 } } },
          },
        },
      ]),
      Ledger.aggregate([
        { $match: { ...baseMatch, transactionType: 'EXPENSE' } },
        {
          $group: {
            _id: '$category',
            amount: { $sum: { $convert: { input: '$amount', to: 'double', onError: 0 } } },
          },
        },
        { $sort: { amount: -1 } },
       
      ]),
      Ledger.countDocuments(baseMatch),
    ]);

    // Format Results
    const income = cashflow.find((c) => c._id === 'INCOME')?.total || 0;
    const expense = cashflow.find((c) => c._id === 'EXPENSE')?.total || 0;

    const netSavings = income - expense;
    const spendPercentage = income > 0 ? (expense / income) * 100 : 0;

 let healthStatus = 'Healthy';

if (income === 0 && expense > 0) {
  healthStatus = 'Critical';
} else if (netSavings < 0) {
  healthStatus = 'Deficit';
} else if (spendPercentage > 80) {
  healthStatus = 'High';
} else if (spendPercentage > 50) {
  healthStatus = 'Moderate';
}

    const designColors = ['#ef4444', '#f59e0b', '#8b5cf6', '#3b82f6', '#10b981'];

    return res.status(200).json({
      success: true,
      data: {
        timeRange: month && year ? `${month}/${year}` : timeframe,
        income,
        expense,
        netSavings,
        savingsRate: income > 0 ? ((netSavings / income) * 100).toFixed(1) : '0.0',
        spendPercentage: parseFloat(spendPercentage.toFixed(1)),
        healthStatus,
        totalTransactions,
        categories: categorySpending.map((c, i) => ({
          name: c._id || 'Uncategorized',
          amount: c.amount,
          percentage: expense > 0 ? ((c.amount / expense) * 100).toFixed(1) : '0.0',
          color: designColors[i] || '#6b7280',
        })),
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─── GOAL ANALYTICS ───────────────────────────────────────────────────────

exports.getGoalProgressAnalytics = async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.id);
    
    const analytics = await Goal.aggregate([
      { $match: { userId: userId } },
      {
        $group: {
          _id: null,
          totalGoals: { $sum: 1 },
          completedGoals: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
          activeGoals: { $sum: { $cond: [{ $eq: ["$status", "active"] }, 1, 0] } },
          overdueGoals: { $sum: { $cond: [{ $eq: ["$status", "overdue"] }, 1, 0] } },
          averageProgress: {
            $avg: {
              $multiply: [
                { $divide: ["$currentAmount", "$targetAmount"] },
                100
              ]
            }
          }
        }
      }
    ]);

    res.status(200).json({ success: true, data: analytics[0] || {} });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getGoalCategoryStats = async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.id);

    const stats = await Goal.aggregate([
      { $match: { userId: userId } },
      {
        $group: {
          _id: "$category",
          count: { $sum: 1 },
          totalTarget: { $sum: "$targetAmount" }
        }
      },
      { $sort: { count: -1 } }
    ]);

    res.status(200).json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getMonthlyGoalSavings = async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.id);

    const stats = await Goal.aggregate([
      { $match: { userId: userId } },
      {
        $project: {
          month: { $month: "$createdAt" },
          currentAmount: 1
        }
      },
      {
        $group: {
          _id: "$month",
          totalSaved: { $sum: "$currentAmount" }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    res.status(200).json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.goalProgressDistribution = async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.id);

    const stats = await Goal.aggregate([
      { $match: { userId: userId } },
      {
        $project: {
          progress: {
            $multiply: [
              { $divide: ["$currentAmount", "$targetAmount"] },
              100
            ]
          }
        }
      },
      {
        $bucket: {
          groupBy: "$progress",
          boundaries: [0, 25, 50, 75, 100],
          default: "completed", // If progress is 100 or above
          output: {
            count: { $sum: 1 }
          }
        }
      }
    ]);

    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.averageCompletionTime = async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.id);

    const stats = await Goal.aggregate([
      { 
        $match: { 
          userId: userId, 
          status: "completed",
          completedAt: { $exists: true } // Ensure it was actually marked completed
        } 
      },
      {
        $project: {
          durationMs: {
            $subtract: ["$completedAt", "$createdAt"]
          }
        }
      },
      {
        $group: {
          _id: null,
          avgTimeMs: { $avg: "$durationMs" }
        }
      }
    ]);

    // Safely convert milliseconds to days to return to the frontend
    let averageDays = 0;
    if (stats.length > 0 && stats[0].avgTimeMs) {
      averageDays = stats[0].avgTimeMs / (1000 * 60 * 60 * 24);
    }

    res.json({ 
      success: true, 
      data: { 
        averageCompletionDays: parseFloat(averageDays.toFixed(1)) 
      } 
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.categorySavings = async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.id);

    const stats = await Goal.aggregate([
      { $match: { userId: userId } },
      {
        $group: {
          _id: "$category",
          totalSaved: { $sum: "$currentAmount" }
        }
      }
    ]);

    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};