'use strict';

/**
 * monthlySummary.job.js
 *
 * Cron job that fires on the 1st of every month at 10:00 AM IST.
 * It summarises the PREVIOUS month's spending for every active user
 * and delivers a personalised AI notification.
 */

const { sendMonthlySummariesToAllUsers } = require('../services/aiMonthlySummary.service');

async function runMonthlySummaryJob() {
  console.log('[Cron] Starting monthly AI summary job...');
  try {
    const results = await sendMonthlySummariesToAllUsers();
    console.log('[Cron] Monthly summary job complete:', results);
  } catch (err) {
    console.error('[Cron] Monthly summary job failed:', err.message);
  }
}

module.exports = { runMonthlySummaryJob };