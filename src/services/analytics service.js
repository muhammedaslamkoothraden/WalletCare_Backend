'use strict';

const mongoose = require('mongoose');
const Ledger = require('../models/Ledger');

async function getUserAnalyticsData(userId, options = {}) {
  const { timeframe = 'month' } = options;

  const now = new Date();
  let startDate, endDate;

  switch (timeframe.toLowerCase()) {
    case 'week':
      startDate = new Date();
      startDate.setDate(now.getDate() - now.getDay());
      startDate.setHours(0, 0, 0, 0);

      endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + 7);
      break;

    case 'year':
      startDate = new Date(now.getFullYear(), 0, 1);
      endDate = new Date(now.getFullYear() + 1, 0, 1);
      break;

    default: // month
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  }

  const match = {
    userId: new mongoose.Types.ObjectId(userId),
    status: 'COMPLETED',
    transactedAt: { $gte: startDate, $lt: endDate },
  };

  const cashflow = await Ledger.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$transactionType',
        total: {
          $sum: { $convert: { input: '$amount', to: 'double', onError: 0 } },
        },
      },
    },
  ]);

  const categorySpending = await Ledger.aggregate([
    { $match: { ...match, transactionType: 'EXPENSE' } },
    {
      $group: {
        _id: '$category',
        amount: {
          $sum: { $convert: { input: '$amount', to: 'double', onError: 0 } },
        },
      },
    },
    { $sort: { amount: -1 } },
    { $limit: 5 },
  ]);

  const income = cashflow.find((c) => c._id === 'INCOME')?.total || 0;
  const expense = cashflow.find((c) => c._id === 'EXPENSE')?.total || 0;

  return {
    income,
    expense,
    netSavings: income - expense,
    categories: categorySpending.map((c) => ({
      name: c._id || 'Other',
      amount: c.amount,
    })),
  };
}

module.exports = { getUserAnalyticsData };