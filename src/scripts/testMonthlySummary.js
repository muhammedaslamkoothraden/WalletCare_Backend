'use strict';

/**
 * testMonthlySummary.js
 *
 * One-time test script — run manually with:
 *   node src/scripts/testMonthlySummary.js
 *
 * What it does:
 *   1. Connects to MongoDB
 *   2. Finds all users who have COMPLETED ledger entries last month
 *   3. Generates an AI summary for each user
 *   4. Saves a notification to DB + sends FCM push
 *   5. Prints a full report in the terminal
 */

require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  // ── 1. Connect to MongoDB ──────────────────────────────────────────────────
  console.log('\n🔌 Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Connected\n');

  // ── 2. Import service AFTER mongoose connects ──────────────────────────────
  const {
    sendMonthlySummariesToAllUsers,
    aggregateMonthlySummary,
  } = require('../services/aiMonthlySummary.service');

  const Ledger = require('../models/Ledger');

  // ── 3. Find active users last month ───────────────────────────────────────
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const end   = new Date(now.getFullYear(), now.getMonth(), 1);

  const activeUserIds = await Ledger.distinct('userId', {
    status: 'COMPLETED',
    transactedAt: { $gte: start, $lt: end },
  });

  const monthLabel = start.toLocaleString('en-IN', { month: 'long', year: 'numeric' });

  console.log(`📅 Generating summaries for: ${monthLabel}`);
  console.log(`👥 Users with activity: ${activeUserIds.length}\n`);

  if (activeUserIds.length === 0) {
    console.log('⚠️  No users found with transactions last month.');
    console.log('   → Insert some test ledger documents dated in March 2026 in Compass first.\n');
    await mongoose.disconnect();
    return;
  }

  // ── 4. Preview each user's data before sending ────────────────────────────
  console.log('─'.repeat(60));
  console.log('📊 USER SPENDING PREVIEW');
  console.log('─'.repeat(60));

  for (const userId of activeUserIds) {
    const data = await aggregateMonthlySummary(userId.toString());
    console.log(`\n👤 User: ${userId}`);
    console.log(`   Income   : ₹${data.income.toFixed(2)}`);
    console.log(`   Expense  : ₹${data.expense.toFixed(2)}`);
    console.log(`   Savings  : ₹${data.netSavings.toFixed(2)} (${data.savingsRate}%)`);
    console.log(`   Tx Count : ${data.txCount}`);
    if (data.topCategories.length) {
      console.log(`   Top Spend: ${data.topCategories[0].name} — ₹${data.topCategories[0].amount.toFixed(2)}`);
    }
  }

  console.log('\n' + '─'.repeat(60));
  console.log('🤖 SENDING AI SUMMARIES...');
  console.log('─'.repeat(60) + '\n');

  // ── 5. Send summaries ──────────────────────────────────────────────────────
  const results = await sendMonthlySummariesToAllUsers();

  // ── 6. Final report ────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(60));
  console.log('✅ DONE — RESULTS');
  console.log('─'.repeat(60));
  console.log(`   ✅ Sent     : ${results.sent}`);
  console.log(`   ⏭️  Skipped  : ${results.skipped}`);
  console.log(`   ❌ Failed   : ${results.failed}`);
  console.log('\n📬 Check your notifications collection in Compass to see the saved messages.');
  console.log('📱 If FCM tokens are set, users received a push notification too.\n');

  await mongoose.disconnect();
  console.log('🔌 Disconnected. Done!\n');
}

main().catch((err) => {
  console.error('\n❌ Script failed:', err.message);
  mongoose.disconnect();
  process.exit(1);
});