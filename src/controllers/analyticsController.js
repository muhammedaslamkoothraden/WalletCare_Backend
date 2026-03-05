const mongoose = require('mongoose');
const Ledger = require('../models/Ledger');
const Goal = require('../models/Goal');

exports.getAnalyticsDashboard = async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const { accountType } = req.query; // 'CASH', 'BANK', or 'All'

    // --- 1. Filter Setup ---
    const matchStage = { userId, status: 'COMPLETED' };
    
    // If user selects "Cash" in Flutter, we filter here
    if (accountType && accountType !== 'All') {
      matchStage.accountType = accountType.toUpperCase();
    }

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);

    // --- 2. Parallel Aggregations ---
    const [summary, topCategories, monthlyTrend, debts, goals] = await Promise.all([
      
      // A. Income vs Expense (Donut Chart Data)
      Ledger.aggregate([
        { $match: { ...matchStage, createdAt: { $gte: startOfMonth } } },
        { $group: { _id: '$transactionType', total: { $sum: '$amount' } } }
      ]),

      // B. Top 4 Categories (Bar Chart Data)
      Ledger.aggregate([
        { $match: { ...matchStage, transactionType: 'EXPENSE', createdAt: { $gte: startOfMonth } } },
        { $group: { _id: '$category', total: { $sum: '$amount' } } },
        { $sort: { total: -1 } },
        { $limit: 4 }
      ]),

      // C. 6-Month Trend (Line Chart Data)
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

      // D. Debt Totals
      Ledger.aggregate([
        { $match: { userId, transactionType: 'DEBT_MANAGEMENT' } },
        { $group: { _id: '$direction', total: { $sum: '$amount' } } }
      ]),

      // E. Goals List
      Goal.find({ userId, status: 'active' }).select('title targetAmount currentAmount')
    ]);

    // --- 3. Data Formatting ---
    const income = summary.find(s => s._id === 'INCOME')?.total || 0;
    const expense = summary.find(s => s._id === 'EXPENSE')?.total || 0;

    res.status(200).json({
      success: true,
      data: {
        summary: {
          income,
          expense: Math.abs(expense),
          net: income - Math.abs(expense)
        },
        topCategories: topCategories.map(c => ({ 
          category: c._id, 
          amount: Math.abs(c.total) 
        })),
        monthlyTrend: monthlyTrend.map(t => ({
          month: t._id.month,
          type: t._id.type,
          amount: Math.abs(t.total)
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
    console.error("Analytics Error:", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};