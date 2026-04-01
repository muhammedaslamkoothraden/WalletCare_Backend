'use strict';

const { reconcileUser } = require('../services/reconciliation');
const User = require('../models/user');

// ─── Reconciliation Job ───────────────────────────────────────────────────────
//
// Run on a schedule using node-cron — e.g. every night at midnight:
//
//   const cron = require('node-cron');
//   cron.schedule('0 0 * * *', runReconciliationJob);
//
// Or trigger manually from an admin endpoint for a specific user:
//
//   router.post('/admin/reconcile/:userId', async (req, res) => {
//     const results = await reconcileUser(req.params.userId, { autoCorrect: false });
//     return res.json({ success: true, results });
//   });

async function runReconciliationJob() {
  console.info('[ReconciliationJob] Starting...');

  // ✅ fixed — User.find wrapped in try/catch so a DB outage
  // doesn't crash the process with an unhandled rejection.
  let users;
  try {
    users = await User.find({}, { _id: 1 }).lean();
  } catch (err) {
    console.error('[ReconciliationJob] Failed to fetch users — aborting', err);
    return;
  }

  console.info(`[ReconciliationJob] Processing ${users.length} users...`);

  let totalAccounts   = 0;
  let totalMismatches = 0;
  let totalErrors     = 0;

  for (const user of users) {
    try {
      const results = await reconcileUser(user._id, { autoCorrect: true });

      for (const r of results) {
        totalAccounts++;
        if (r.status === 'MISMATCH' || r.status === 'MISMATCH_LARGE') totalMismatches++;
        if (r.status === 'ERROR') totalErrors++;

        // Log every mismatch so there is an audit trail even when autoCorrect
        // fixes it. MISMATCH_LARGE always needs a human to follow up.
        if (r.status !== 'OK') {
          console.warn('[ReconciliationJob] Mismatch detected', {
            userId:            user._id,
            accountId:         r.accountId,
            accountName:       r.accountName,
            status:            r.status,
            deltaAvailable:    r.deltaAvailable,
            deltaReserved:     r.deltaReserved,
            corrected:         r.corrected,
            error:             r.error,
          });
        }
      }
    } catch (err) {
      // ✅ fixed — totalErrors incremented so the summary reflects
      // users that threw unexpectedly, not just account-level errors.
      console.error('[ReconciliationJob] User failed', user._id, err);
      totalErrors++;
    }
  }

  console.info('[ReconciliationJob] Done', {
    totalAccounts,
    totalMismatches,
    totalErrors,
  });
}

module.exports = { runReconciliationJob };