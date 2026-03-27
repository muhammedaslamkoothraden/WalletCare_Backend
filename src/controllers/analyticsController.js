const mongoose = require('mongoose');
const Ledger = require('../models/Ledger');
const Account = require('../models/Account');
const Goal = require('../models/Goal');



exports.getAnalyticsDashboard = async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const { accountId, timeframe } = req.query; // timeframe: 'week' or 'month'

    // --- 1. Calculate Date Range ---
    const now = new Date();
    let startDate;

    if (timeframe === 'week') {
      // Start of current week (Sunday)
      startDate = new Date(now.setDate(now.getDate() - now.getDay()));
      startDate.setHours(0, 0, 0, 0);
    } else {
      // Start of current month
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    }

    // --- 2. Build Dynamic Match Stage ---
    const matchStage = {
      userId,
      status: 'COMPLETED',
      createdAt: { $gte: startDate },
      // Important: Exclude internal goal movements from Income/Expense totals
      direction: 'NORMAL'
    };

    // Filter by specific account if provided and not "all"
    if (accountId && accountId !== 'all') {
      matchStage.accountId = new mongoose.Types.ObjectId(accountId);
    }

    // --- 3. Run Aggregations in Parallel ---
    const [cashflow, categorySpending, accountData] = await Promise.all([
      // A. Total Income vs Total Expense
      Ledger.aggregate([
        { $match: matchStage },
        { $group: { _id: '$transactionType', total: { $sum: '$amount' } } }
      ]),

      // B. Category-wise Spending (Expenses Only)
      Ledger.aggregate([
        { $match: { ...matchStage, transactionType: 'EXPENSE' } },
        { $group: { _id: '$category', amount: { $sum: '$amount' } } },
        { $sort: { amount: -1 } }
      ]),

      // C. Reserved Balance (Current snapshot, not date-dependent)
      Account.aggregate([
        {
          $match: (accountId && accountId !== 'all')
            ? { _id: new mongoose.Types.ObjectId(accountId) }
            : { userId, status: 'ACTIVE' }
        },
        { $group: { _id: null, totalReserved: { $sum: '$reservedBalance' } } }
      ])
    ]);

    // --- 4. Format Data for Pie Chart & UI ---
    // Note: Use .toString() or parseFloat because Decimal128 is an object
    const income = cashflow.find(c => c._id === 'INCOME')?.total?.toString() || "0.00";
    const expense = cashflow.find(c => c._id === 'EXPENSE')?.total?.toString() || "0.00";
    const reserved = accountData[0]?.totalReserved?.toString() || "0.00";

    res.status(200).json({
      success: true,
      data: {
        period: timeframe === 'week' ? 'This Week' : 'This Month',
        // 🎯 Ready for Flutter Pie Chart
        pieChart: [
          { label: 'Income', value: parseFloat(income), color: '#4CAF50' },
          { label: 'Expense', value: Math.abs(parseFloat(expense)), color: '#F44336' },
          { label: 'Reserved', value: parseFloat(reserved), color: '#FF9800' }
        ],
        // 🎯 Category List
        categorySpending: categorySpending.map(c => ({
          category: c._id,
          amount: Math.abs(parseFloat(c.amount.toString()))
        })),
        summary: {
          income,
          expense: Math.abs(parseFloat(expense)).toFixed(2),
          reserved,
          net: (parseFloat(income) - Math.abs(parseFloat(expense))).toFixed(2)
        }
      }
    });

  } catch (error) {
    console.error("Analytics Error:", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
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