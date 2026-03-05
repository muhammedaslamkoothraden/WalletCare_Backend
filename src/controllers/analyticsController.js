const mongoose = require('mongoose');
const Decimal = require('decimal.js');
const Ledger = require('../models/Ledger');
const Goal = require('../models/Goal');

exports.getAnalyticsDashboard = async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.id);
    
    const now = new Date();
    const startOfCurrentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    
    const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);

    const currentMonthStatsPromise = Ledger.aggregate([
      { 
        $match: { 
          userId, 
          createdAt: { $gte: startOfCurrentMonth },
          status: 'COMPLETED',
          transactionType: { $in: ['INCOME', 'EXPENSE'] }
        } 
      },
      {
        $group: {
          _id: '$transactionType',
          totalAmount: { $sum: '$amount' },
          count: { $sum: 1 }
        }
      }
    ]);

    const topCategoriesPromise = Ledger.aggregate([
      { 
        $match: { 
          userId, 
          createdAt: { $gte: startOfCurrentMonth },
          transactionType: 'EXPENSE',
          status: 'COMPLETED'
        } 
      },
      {
        $group: {
          _id: '$category',
          total: { $sum: '$amount' }
        }
      },
      { $sort: { total: -1 } },
      { $limit: 4 }
    ]);

    const monthlyTrendPromise = Ledger.aggregate([
      { 
        $match: { 
          userId, 
          createdAt: { $gte: sixMonthsAgo },
          status: 'COMPLETED',
          transactionType: { $in: ['INCOME', 'EXPENSE'] }
        } 
      },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
            type: '$transactionType'
          },
          total: { $sum: '$amount' }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } }
    ]);

    const debtStatsPromise = Ledger.aggregate([
      { 
        $match: { 
          userId, 
          transactionType: 'DEBT_MANAGEMENT',
          status: 'COMPLETED'
        } 
      },
      {
        $group: {
          _id: '$direction',
          total: { $sum: '$amount' },
          count: { $sum: 1 }
        }
      }
    ]);

    const goalsPromise = Goal.find({ userId, status: 'active' }).select('title targetAmount currentAmount').lean();

    const [
      currentMonthStats, 
      topCategories, 
      monthlyTrend, 
      debtStats, 
      activeGoals
    ] = await Promise.all([
      currentMonthStatsPromise,
      topCategoriesPromise,
      monthlyTrendPromise,
      debtStatsPromise,
      goalsPromise
    ]);

    let totalIncome = new Decimal(0);
    let totalExpense = new Decimal(0);
    let totalTransactions = 0;

    currentMonthStats.forEach(stat => {
      totalTransactions += stat.count;
      if (stat._id === 'INCOME') totalIncome = new Decimal(stat.totalAmount.toString());
      if (stat._id === 'EXPENSE') totalExpense = new Decimal(stat.totalAmount.toString());
    });

    const netAmount = totalIncome.minus(totalExpense);
    
    let savingsRate = 0;
    if (totalIncome.greaterThan(0) && netAmount.greaterThan(0)) {
      savingsRate = netAmount.dividedBy(totalIncome).times(100).toFixed(0);
    }

    let toReceive = new Decimal(0);
    let toPay = new Decimal(0);
    let debtRecordsCount = 0;

    debtStats.forEach(stat => {
      debtRecordsCount += stat.count;
      if (stat._id === 'DEBIT') toReceive = new Decimal(stat.total.toString());
      if (stat._id === 'CREDIT') toPay = new Decimal(stat.total.toString());
    });

    const formattedGoals = activeGoals.map(g => {
      const percentage = Math.min((g.currentAmount / g.targetAmount) * 100, 100);
      return {
        title: g.title,
        progress: Number(percentage.toFixed(0))
      };
    });

    return res.status(200).json({
      success: true,
      data: {
        summary: {
          net: netAmount.toFixed(2),
          income: totalIncome.toFixed(2),
          expense: totalExpense.toFixed(2)
        },
        statistics: {
          totalTransactions,
          activeGoalsCount: activeGoals.length,
          savingsRate: `${savingsRate}%`,
          debtRecords: debtRecordsCount
        },
        topCategories: topCategories.map(cat => ({
          category: cat._id,
          amount: cat.total.toString()
        })),
        debtOverview: {
          toReceive: toReceive.toFixed(2),
          toPay: toPay.toFixed(2)
        },
        goalsProgress: formattedGoals,
        monthlyTrend: monthlyTrend.map(point => ({
          month: point._id.month,
          year: point._id.year,
          type: point._id.type,
          amount: point.total.toString()
        }))
      }
    });

  } catch (error) {
    console.error('ANALYTICS_DASHBOARD_ERROR:', error);
    return res.status(500).json({ success: false, message: 'Failed to load analytics data' });
  }
};