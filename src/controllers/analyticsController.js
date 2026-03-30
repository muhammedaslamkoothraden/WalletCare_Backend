const mongoose = require('mongoose');
const Ledger = require('../models/Ledger');
const Account = require('../models/Account');
const Goal = require('../models/Goal');


exports.getAnalyticsDashboard = async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const { accountId, timeframe = 'Month' } = req.query;

    // ─── 1. Calculate Start Date ───────────────────────────────────────────────

    const now = new Date();
    let startDate = new Date();

    switch (timeframe.toLowerCase()) {
      case 'day':
        startDate.setHours(0, 0, 0, 0);
        break;
      case 'week':
        startDate = new Date(now);
        startDate.setDate(now.getDate() - now.getDay());
        startDate.setHours(0, 0, 0, 0);
        break;
      case 'year':
        startDate = new Date(now.getFullYear(), 0, 1);
        break;
      default: // 'month'
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    }

    // ─── 2. Build Base Match Stage ─────────────────────────────────────────────

    const baseMatch = {
      userId,
      status: 'COMPLETED',
      transactedAt: { $gte: startDate },
    };

    if (accountId && accountId !== 'all') {
      baseMatch.accountId = new mongoose.Types.ObjectId(accountId);
    }

    // ─── 3. Run Aggregations ───────────────────────────────────────────────────

    // FIX: $sum cannot natively aggregate Decimal128 fields — it silently
    // returns 0. Wrap $amount in $toDouble before summing so MongoDB can
    // perform the arithmetic. $toDouble is appropriate here because dashboard
    // figures are display values; full Decimal128 precision is only needed
    // on the ledger write path (balance mutations).

    const [cashflow, categorySpending, totalTransactions] = await Promise.all([

      // Cashflow: total INCOME and EXPENSE for the period
      Ledger.aggregate([
        { $match: baseMatch },
        {
          $group: {
            _id: '$transactionType',
            total: { $sum: { $toDouble: '$amount' } }, // ✅ Fix
          },
        },
      ]),

      // Category breakdown: top 5 expense categories
      Ledger.aggregate([
        { $match: { ...baseMatch, transactionType: 'EXPENSE' } },
        {
          $group: {
            _id: '$category',
            amount: { $sum: { $toDouble: '$amount' } }, // ✅ Fix
          },
        },
        { $sort: { amount: -1 } },
        { $limit: 5 },
      ]),

      // Total transaction count for the period
      Ledger.countDocuments(baseMatch),
    ]);

    // ─── 4. Format Results ─────────────────────────────────────────────────────

    const incomeObj = cashflow.find((c) => c._id === 'INCOME');
    const expenseObj = cashflow.find((c) => c._id === 'EXPENSE');

    // Both are plain JS numbers after $toDouble conversion
    const income = incomeObj ? incomeObj.total : 0;
    const expense = expenseObj ? expenseObj.total : 0; // Already positive in ledger

    const netSavings = income - expense;
    const spendPercentage = income > 0 ? (expense / income) * 100 : 0;

    let healthStatus = 'Healthy';
    if (income === 0 && expense > 0) {
      healthStatus = 'High';   // Spending recorded with no income
    } else if (spendPercentage > 70) {
      healthStatus = 'High';
    } else if (spendPercentage > 40) {
      healthStatus = 'Moderate';
    }

    const designColors = ['#ef4444', '#f59e0b', '#8b5cf6', '#3b82f6', '#10b981'];

    // ─── 5. Respond ────────────────────────────────────────────────────────────

    return res.status(200).json({
      success: true,
      data: {
        timeRange: timeframe,
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
          percentage:
            expense > 0
              ? ((c.amount / expense) * 100).toFixed(1)
              : '0.0',
          color: designColors[i] || '#6b7280',
        })),
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
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