const mongoose = require('mongoose');
const Ledger = require('../models/Ledger');
const Goal = require('../models/Goal');

exports.getAnalyticsDashboard = async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const { accountType } = req.query; // Supports 'CASH', 'BANK', or 'All'

    // --- 1. Dynamic Match Stage ---
    // This allows the "Cash/Account" filter in Flutter to work
    const matchStage = { userId, status: 'COMPLETED' };
    if (accountType && accountType !== 'All') {
      matchStage.accountType = accountType.toUpperCase();
    }

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);

    // --- 2. Run All Aggregations Concurrently ---
    const [summary, topCategories, monthlyTrend, debts, goals] = await Promise.all([
      // A. Total Income vs Expense (Current Month)
      Ledger.aggregate([
        { $match: { ...matchStage, createdAt: { $gte: startOfMonth } } },
        { $group: { _id: '$transactionType', total: { $sum: '$amount' } } }
      ]),

      // B. Top 4 Spending Categories
      Ledger.aggregate([
        { $match: { ...matchStage, transactionType: 'EXPENSE', createdAt: { $gte: startOfMonth } } },
        { $group: { _id: '$category', total: { $sum: '$amount' } } },
        { $sort: { total: -1 } },
        { $limit: 4 }
      ]),

      // C. 6-Month Trend Data (Line Chart)
      Ledger.aggregate([
        { $match: { ...matchStage, createdAt: { $gte: sixMonthsAgo } } },
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
      ]),

      // D. Debt Overview
      Ledger.aggregate([
        { $match: { userId, transactionType: 'DEBT_MANAGEMENT' } },
        { $group: { _id: '$direction', total: { $sum: '$amount' } } }
      ]),

      // E. Goal Progress
      Goal.find({ userId, status: 'active' }).select('title targetAmount currentAmount')
    ]);

    // --- 3. Format Response ---
    const formattedSummary = {
      income: summary.find(s => s._id === 'INCOME')?.total || 0,
      expense: summary.find(s => s._id === 'EXPENSE')?.total || 0,
    };

    res.status(200).json({
      success: true,
      data: {
        summary: {
          ...formattedSummary,
          net: formattedSummary.income - Math.abs(formattedSummary.expense)
        },
        topCategories: topCategories.map(c => ({ category: c._id, amount: c.total })),
        monthlyTrend: monthlyTrend.map(t => ({
          month: t._id.month,
          type: t._id.type,
          amount: t.total
        })),
        debts: {
          toReceive: debts.find(d => d._id === 'DEBIT')?.total || 0,
          toPay: debts.find(d => d._id === 'CREDIT')?.total || 0,
        },
        goals: goals.map(g => ({
          title: g.title,
          progress: (g.currentAmount / g.targetAmount) * 100
        }))
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};