// controllers/analyticsController.js
const Ledger = require('../models/Ledger');
const mongoose = require('mongoose');

exports.getAnalyticsOverview = async (req, res) => {
    try {
        // Since no JWT, we get the ID from the URL: /api/analytics?userId=XXXX
        const { userId } = req.query;

        if (!userId) {
            return res.status(400).json({ success: false, message: "User ID is required" });
        }

        const userObjectId = new mongoose.Types.ObjectId(userId);

        const analytics = await Ledger.aggregate([
            // 1. Filter only this user's data
            { $match: { userId: userObjectId } },
            {
                $facet: {
                    "monthlyTrend": [
                        { $group: {
                            _id: { month: { $month: "$createdAt" }, type: "$transactionType" },
                            total: { $sum: { $toDouble: "$amount" } }
                        }},
                        { $sort: { "_id.month": 1 } }
                    ],
                    "categories": [
                        { $match: { transactionType: 'DEBIT' } },
                        { $group: { _id: "$category", total: { $sum: { $toDouble: "$amount" } } } }
                    ]
                }
            }
        ]);

        res.status(200).json({ success: true, data: analytics[0] });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};