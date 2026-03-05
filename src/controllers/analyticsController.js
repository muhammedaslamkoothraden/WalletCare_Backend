// controllers/analyticsController.js
const Ledger = require('../models/Ledger'); // Your Transaction model
const mongoose = require('mongoose');

exports.getAnalyticsOverview = async (req, res) => {
    try {
        const userId = new mongoose.Types.ObjectId(req.user.id);
        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

        // 1. Calculate Monthly Income vs Expense Trend
        const monthlyTrend = await Ledger.aggregate([
            { $match: { userId, createdAt: { $gte: sixMonthsAgo } } },
            {
                $group: {
                    _id: { 
                        month: { $month: "$createdAt" }, 
                        year: { $year: "$createdAt" },
                        type: "$transactionType" 
                    },
                    total: { $sum: { $toDouble: "$amount" } }
                }
            },
            { $sort: { "_id.year": 1, "_id.month": 1 } }
        ]);

        // 2. Top Spending Categories (DEBIT types)
        const topCategories = await Ledger.aggregate([
            { $match: { userId, transactionType: 'DEBIT', purpose: 'EXPENSE' } },
            { $group: { _id: "$category", total: { $sum: { $toDouble: "$amount" } } } },
            { $sort: { total: -1 } },
            { $limit: 5 }
        ]);

        res.json({ success: true, monthlyTrend, topCategories });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};