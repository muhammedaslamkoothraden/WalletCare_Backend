'use strict';

/**
 * monthlySummary.controller.js
 *
 * Exposes two endpoints:
 *
 *  GET  /api/summary/monthly          — Returns current user's last-month summary JSON
 *                                        (no notification sent, for Flutter preview screen)
 *
 *  POST /api/summary/monthly/trigger  — Admin-only: manually triggers the full batch job
 *                                        (useful for testing without waiting for cron)
 */

const {
  sendMonthlySummaryToUser,
  sendMonthlySummariesToAllUsers,
  aggregateMonthlySummary,
} = require('../services/aiMonthlySummary.service');

// ─── GET /api/summary/monthly ─────────────────────────────────────────────────
// Returns the aggregated data + AI-generated text for the authenticated user.
// Does NOT save a notification — purely a read endpoint for preview.

exports.getMyMonthlySummary = async (req, res) => {
  try {
    const userId = req.user.id;

    // 1. Fetch aggregated data (always available, no API call)
    const data = await aggregateMonthlySummary(userId);

    if (data.txCount === 0) {
      return res.status(200).json({
        success: true,
        hasActivity: false,
        message: 'No transactions found for last month.',
        data: null,
      });
    }

    // 2. Generate and send notification (also returns the message text)
    const result = await sendMonthlySummaryToUser(userId);

    return res.status(200).json({
      success: true,
      hasActivity: true,
      monthLabel: data.monthLabel,
      summary: {
        income: data.income,
        expense: data.expense,
        netSavings: data.netSavings,
        savingsRate: data.savingsRate,
        topCategories: data.topCategories,
        txCount: data.txCount,
      },
      aiMessage: result.message,
      source: result.source, // 'ai' or 'fallback'
    });
  } catch (err) {
    console.error('[MonthlySummary] getMyMonthlySummary error:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to generate monthly summary.',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
};

// ─── POST /api/summary/monthly/trigger ────────────────────────────────────────
// Admin-only: fires the batch job immediately. Good for demos and testing.

exports.triggerMonthlySummaryBatch = async (req, res) => {
  try {
    // Non-blocking: start the job but respond immediately so HTTP doesn't timeout
    // for large user bases.
    res.status(202).json({
      success: true,
      message: 'Monthly summary batch job triggered. Processing in background.',
    });

    // Run after response is sent
    setImmediate(async () => {
      try {
        const results = await sendMonthlySummariesToAllUsers();
        console.log('[MonthlySummary] Batch trigger results:', results);
      } catch (err) {
        console.error('[MonthlySummary] Batch trigger failed:', err.message);
      }
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'Failed to trigger batch job.',
    });
  }
};