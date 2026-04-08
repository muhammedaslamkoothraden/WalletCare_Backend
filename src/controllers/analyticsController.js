const mongoose = require('mongoose');
const Ledger = require('../models/ledger');
const Account = require('../models/Account');
const Goal = require('../models/Goal');


exports.getAnalyticsDashboard = async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.id);
    
    // 1. Extract new month and year parameters
    const { accountId, timeframe = 'Month', month, year } = req.query;

    const now = new Date();
    let startDate;
    let endDate; 

    // ─── 1. Improved Date Calculation with Explicit End Dates ───────────
    if (month && year) {
      // If client requests a SPECIFIC month (e.g., month=3, year=2024)
      const m = parseInt(month, 10) - 1; // JavaScript months are 0-indexed (0 = Jan)
      const y = parseInt(year, 10);
      
      startDate = new Date(y, m, 1, 0, 0, 0, 0);
      endDate = new Date(y, m + 1, 1, 0, 0, 0, 0); // Exact start of the next month
    } else {
      // Fallback to relative timeframes (Current Day, Week, Month, Year)
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
        default: // 'month' (Current month)
          startDate = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
          endDate = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
      }
    }

    // ─── 2. Build Base Match Stage (Now with a strict window) ───────────
    const baseMatch = {
      userId,
      status: 'COMPLETED',
      transactedAt: { 
        $gte: startDate, 
        $lt: endDate // 🔥 Prevents bleeding into the next month
      },
    };

    if (accountId && accountId !== 'all') {
      baseMatch.accountId = new mongoose.Types.ObjectId(accountId);
    }

    // ─── 2.5 Exclude Reversed Transactions and Their Parents ────────────
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

    // ─── 3. Run Aggregations ─────────────────────────────────────────────
    // NOTE: Using $convert is safer than $toDouble in case amount is null/missing
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
        { $limit: 5 },
      ]),
      Ledger.countDocuments(baseMatch),
    ]);

    // ─── 4. Format Results ───────────────────────────────────────────────
    const income = cashflow.find((c) => c._id === 'INCOME')?.total || 0;
    const expense = cashflow.find((c) => c._id === 'EXPENSE')?.total || 0;

    const netSavings = income - expense;
    const spendPercentage = income > 0 ? (expense / income) * 100 : 0;

    let healthStatus = 'Healthy';
    if (income === 0 && expense > 0) {
      healthStatus = 'High';
    } else if (spendPercentage > 70) {
      healthStatus = 'High';
    } else if (spendPercentage > 40) {
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
// Example of the ObjectId Fix for your Goal Analytics:
exports.getGoalProgressAnalytics = async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.id); // ALWAYS CAST THIS
    const analytics = await Goal.aggregate([
      { $match: { userId: userId } }, // Uses the casted ID
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


// ANALYTICS: GOAL PROGRESS
exports.getGoalProgressAnalytics = async (req, res) => {
  try {

    const analytics = await Goal.aggregate([
      {
        $match: { userId: req.user.id }
      },
      {
        $group: {
          _id: null,
          totalGoals: { $sum: 1 },

          completedGoals: {
            $sum: {
              $cond: [{ $eq: ["$status", "completed"] }, 1, 0]
            }
          },

          activeGoals: {
            $sum: {
              $cond: [{ $eq: ["$status", "active"] }, 1, 0]
            }
          },

          overdueGoals: {
            $sum: {
              $cond: [{ $eq: ["$status", "overdue"] }, 1, 0]
            }
          },

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

    res.status(200).json({
      success: true,
      data: analytics[0] || {}
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};


// ANALYTICS: GOAL CATEGORY STATS
exports.getGoalCategoryStats = async (req, res) => {
  try {

    const stats = await Goal.aggregate([
      {
        $match: { userId: req.user.id }
      },
      {
        $group: {
          _id: "$category",
          count: { $sum: 1 },
          totalTarget: { $sum: "$targetAmount" }
        }
      },
      {
        $sort: { count: -1 }
      }
    ]);

    res.status(200).json({
      success: true,
      data: stats
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};
// ANALYTICS: MONTHLY GOAL SAVINGS
exports.getMonthlyGoalSavings = async (req, res) => {
  try {

    const stats = await Goal.aggregate([
      {
        $match: { userId: req.user.id }
      },
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
      {
        $sort: { _id: 1 }
      }
    ]);

    res.status(200).json({
      success: true,
      data: stats
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// ANALYTICS: GOAL PROGRESS DISTRIBUTION
exports.goalProgressDistribution =
  async (req, res) => {

    const stats =
      await Goal.aggregate([

        {
          $match: {
            userId: req.user.id
          }
        },

        {
          $project: {

            progress: {
              $multiply: [
                {
                  $divide: [
                    "$currentAmount",
                    "$targetAmount"
                  ]
                },
                100
              ]
            }

          }
        },

        {
          $bucket: {

            groupBy: "$progress",

            boundaries: [0, 25, 50, 75, 100],

            default: "completed",

            output: {
              count: { $sum: 1 }
            }

          }

        }

      ]);

    res.json({
      success: true,
      data: stats
    });

  };

// ANALYTICS: AVERAGE COMPLETION TIME FOR GOALS
exports.averageCompletionTime =
  async (req, res) => {

    const stats =
      await Goal.aggregate([

        {
          $match: {
            status: "completed"
          }
        },

        {
          $project: {

            duration: {
              $subtract: [
                "$completedAt",
                "$createdAt"
              ]
            }

          }
        },

        {
          $group: {

            _id: null,

            avgTime: {
              $avg: "$duration"
            }

          }
        }

      ]);

    res.json({
      success: true,
      data: stats
    });

  };

//  ANALYTICS: TOTAL SAVED AMOUNT BY CATEGORY
exports.categorySavings =
  async (req, res) => {

    const stats =
      await Goal.aggregate([

        {
          $match: {
            userId: req.user.id
          }
        },

        {
          $group: {

            _id: "$category",

            totalSaved: {
              $sum: "$currentAmount"
            }

          }
        }

      ]);

    res.json({
      success: true,
      data: stats
    });

  };