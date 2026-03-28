const mongoose = require('mongoose');
const Ledger = require('../models/Ledger');
const Account = require('../models/Account');
const Goal = require('../models/Goal');


exports.getAnalyticsDashboard = async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const { accountId, timeframe = 'Month' } = req.query;

    // 1. Calculate Start Date
    const now = new Date();
    let startDate = new Date();
    switch (timeframe.toLowerCase()) {
      case 'day': startDate.setHours(0, 0, 0, 0); break;
      case 'week':
        startDate = new Date(now.setDate(now.getDate() - now.getDay()));
        startDate.setHours(0, 0, 0, 0);
        break;
      case 'year': startDate = new Date(now.getFullYear(), 0, 1); break;
      default: startDate = new Date(now.getFullYear(), now.getMonth(), 1); // Month
    }

    // 2. Build Dynamic Match Stage
    const matchStage = {
      userId,
      status: 'COMPLETED',
      transactedAt: { $gte: startDate },
      direction: 'STANDARD'
    };

    // Account Filtering Logic: If 'all', don't add accountId to match
    if (accountId && accountId !== 'all') {
      matchStage.accountId = new mongoose.Types.ObjectId(accountId);
    }

    // 3. Run Aggregations
    const [cashflow, categorySpending, totalTransactions] = await Promise.all([
      Ledger.aggregate([
        { $match: matchStage },
        { $group: { _id: '$transactionType', total: { $sum: '$amount' } } }
      ]),
      Ledger.aggregate([
        { $match: { ...matchStage, transactionType: 'EXPENSE' } },
        { $group: { _id: '$category', amount: { $sum: '$amount' } } },
        { $sort: { amount: -1 } },
        { $limit: 5 }
      ]),
      Ledger.countDocuments(matchStage)
    ]);

    // 4. Formatting
    const income = cashflow.find(c => c._id === 'INCOME')?.total || 0;
    const expense = Math.abs(cashflow.find(c => c._id === 'EXPENSE')?.total || 0);
    const netSavings = income - expense;
    const spendPercentage = income > 0 ? ((expense / income) * 100).toFixed(1) : 0;

    const designColors = ['#ef4444', '#f59e0b', '#8b5cf6', '#3b82f6', '#10b981'];

    res.status(200).json({
      success: true,
      data: {
        timeRange: timeframe,
        income,
        expense,
        netSavings,
        savingsRate: income > 0 ? ((netSavings / income) * 100).toFixed(1) : 0,
        spendPercentage: parseFloat(spendPercentage),
        healthStatus: spendPercentage <= 40 ? "Healthy" : spendPercentage <= 70 ? "Moderate" : "High",
        totalTransactions,
        categories: categorySpending.map((c, i) => ({
          name: c._id,
          amount: Math.abs(c.amount),
          percentage: expense > 0 ? ((Math.abs(c.amount) / expense) * 100).toFixed(1) : 0,
          color: designColors[i] || '#6b7280'
        }))
      }
    });
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