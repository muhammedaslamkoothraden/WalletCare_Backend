'use strict';

const { reconcileUser } = require('../services/reconciliation');
const User = require('../models/User');

// ─── Reconciliation Job ───────────────────────────────────────────────────────
//
// Run this on a schedule — e.g. every night at midnight using node-cron:
//
//   const cron = require('node-cron');
//   cron.schedule('0 0 * * *', runReconciliationJob);
//
// Or trigger it manually from an admin endpoint for a specific user.

async function runReconciliationJob() {
  console.info('[ReconciliationJob] Starting...');

  // Get all active users — adjust query to your User model
  const users = await User.find({}, { _id: 1 }).lean();

  let totalAccounts = 0;
  let totalMismatches = 0;
  let totalErrors = 0;

  for (const user of users) {
    try {
      const results = await reconcileUser(user._id, { autoCorrect: true });

      for (const r of results) {
        totalAccounts++;
        if (r.status === 'MISMATCH') totalMismatches++;
        if (r.status === 'MISMATCH_LARGE') totalMismatches++;
        if (r.status === 'ERROR') totalErrors++;
      }
    } catch (err) {
      console.error('[ReconciliationJob] User failed', user._id, err);
    }
  }

  console.info('[ReconciliationJob] Done', {
    totalAccounts,
    totalMismatches,
    totalErrors,
  });
}

// ─── Manual trigger from admin endpoint ──────────────────────────────────────
//
// In your admin router:
//
//   router.post('/admin/reconcile/:userId', async (req, res) => {
//     const results = await reconcileUser(req.params.userId, { autoCorrect: false });
//     return res.json({ success: true, results });
//   });

module.exports = { runReconciliationJob };