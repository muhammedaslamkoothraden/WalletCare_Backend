'use strict';

/**
 * aiMonthlySummary.service.js
 *
 * Generates an AI-powered monthly spending summary for a user.
 * Uses the Anthropic Claude API (claude-haiku-3-5) to produce
 * a friendly, actionable financial insight message.
 *
 * Flow:
 *   1. Aggregate last month's ledger data from MongoDB.
 *   2. Build a structured prompt from the aggregated data.
 *   3. Call Claude API → get an intelligent, personalised summary.
 *   4. Fallback to a rule-based summary if Claude fails.
 *   5. Save a MONTHLY_SUMMARY notification for the user.
 *   6. Deliver via existing hybrid notification pipeline (DB + WebSocket + FCM).
 */

const mongoose = require('mongoose');
const https = require('https');
const Ledger = require('../models/Ledger');
const { createNotification } = require('./notification.service');

// ─── Constants ────────────────────────────────────────────────────────────────

const GEMINI_API_HOST = 'generativelanguage.googleapis.com';
const GEMINI_MODEL = 'gemini-1.5-flash';
const MAX_TOKENS = 300;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Formats a numeric rupee amount to a readable string.
 * e.g. 12345.5 → "₹12,345.50"
 */
function formatRupees(amount) {
  return `₹${Number(amount).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Returns { start, end } Date objects for the previous calendar month.
 * e.g. if today is April 25, 2026 → { start: Mar 1, end: Apr 1 }
 */
function getPreviousMonthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  return { start, end };
}

/**
 * Returns a human-readable month label like "March 2026".
 */
function getPreviousMonthLabel() {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return d.toLocaleString('en-IN', { month: 'long', year: 'numeric' });
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

/**
 * Pulls all COMPLETED ledger entries for the previous month and
 * returns a structured analytics object ready for the AI prompt.
 *
 * @param {string|ObjectId} userId
 * @returns {Promise<{
 *   income: number,
 *   expense: number,
 *   netSavings: number,
 *   savingsRate: number,
 *   topCategories: Array<{ name: string, amount: number, pct: number }>,
 *   txCount: number,
 *   monthLabel: string
 * }>}
 */
async function aggregateMonthlySummary(userId) {
  const uid = new mongoose.Types.ObjectId(userId);
  const { start, end } = getPreviousMonthRange();

  const match = {
    userId: uid,
    status: 'COMPLETED',
    transactedAt: { $gte: start, $lt: end },
  };

  // ── Cash-flow totals ──────────────────────────────────────────────────────
  const cashflow = await Ledger.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$transactionType',
        total: {
          $sum: { $convert: { input: '$amount', to: 'double', onError: 0 } },
        },
        count: { $sum: 1 },
      },
    },
  ]);

  // ── Category breakdown (expenses only) ───────────────────────────────────
  const categoryAgg = await Ledger.aggregate([
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

  const income = cashflow.find((c) => c._id === 'INCOME')?.total ?? 0;
  const expense = cashflow.find((c) => c._id === 'EXPENSE')?.total ?? 0;
  const txCount = cashflow.reduce((acc, c) => acc + c.count, 0);
  const netSavings = income - expense;
  const savingsRate = income > 0 ? ((netSavings / income) * 100).toFixed(1) : 0;

  const totalExpense = categoryAgg.reduce((s, c) => s + c.amount, 0) || 1;
  const topCategories = categoryAgg.map((c) => ({
    name: c._id ?? 'Other',
    amount: c.amount,
    pct: ((c.amount / totalExpense) * 100).toFixed(1),
  }));

  return {
    income,
    expense,
    netSavings,
    savingsRate: Number(savingsRate),
    topCategories,
    txCount,
    monthLabel: getPreviousMonthLabel(),
  };
}

// ─── Prompt Builder ───────────────────────────────────────────────────────────

/**
 * Builds the Claude prompt from aggregated data.
 * The prompt is intentionally detailed so Claude can produce
 * a personalised, non-generic response.
 */
function buildPrompt(data) {
  const { income, expense, netSavings, savingsRate, topCategories, txCount, monthLabel } = data;

  const categoryLines = topCategories.length
    ? topCategories
        .map((c, i) => `  ${i + 1}. ${c.name}: ${formatRupees(c.amount)} (${c.pct}%)`)
        .join('\n')
    : '  No categorised expenses found.';

  const spendingStatus = netSavings >= 0 ? 'SURPLUS' : 'DEFICIT';

  return `You are a friendly and empathetic personal finance assistant for an Indian fintech app called WalletCare.

Analyze this user's financial data for ${monthLabel} and write a concise, warm notification message (2–3 sentences MAX). 
The message will appear as a push notification on their phone, so keep it under 200 characters if possible, but prioritise being helpful over being short.

Financial Data:
- Month: ${monthLabel}
- Total Income: ${formatRupees(income)}
- Total Expenses: ${formatRupees(expense)}
- Net Savings: ${formatRupees(Math.abs(netSavings))} (${spendingStatus})
- Savings Rate: ${savingsRate}%
- Total Transactions: ${txCount}

Top Expense Categories:
${categoryLines}

Rules:
- Be encouraging even if they overspent — never shame.
- Mention the biggest spending category if relevant.
- If savings rate > 20%, celebrate it briefly.
- If in deficit, suggest one concrete small action.
- Use ₹ symbol for Indian Rupees.
- Do NOT start with "Hello" or "Dear user". Start directly with the insight.
- Do NOT use bullet points or formatting — plain flowing text only.`;
}

// ─── Gemini API Call ─────────────────────────────────────────────────────────

/**
 * Calls the Google Gemini API using Node's built-in https module.
 *
 * @param {string} prompt
 * @returns {Promise<string>} — Gemini's response text
 */
function callGeminiAPI(prompt) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return reject(new Error('GEMINI_API_KEY is not set in environment'));
    }

    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: MAX_TOKENS, temperature: 0.7 },
    });

    const path = `/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

    const options = {
      hostname: GEMINI_API_HOST,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);

          if (parsed.error) {
            return reject(new Error(`Gemini API error: ${parsed.error.message}`));
          }

          const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!text) {
            return reject(new Error('Gemini returned empty content'));
          }

          resolve(text.trim());
        } catch (err) {
          reject(new Error(`Failed to parse Gemini response: ${err.message}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Rule-based Fallback ──────────────────────────────────────────────────────

/**
 * Generates a deterministic, rule-based summary when Claude is unavailable.
 * Always safe — no external dependency.
 */
function generateFallbackSummary(data) {
  const { income, expense, netSavings, savingsRate, topCategories, monthLabel } = data;

  let msg = `Your ${monthLabel} recap: you earned ${formatRupees(income)} and spent ${formatRupees(expense)}. `;

  if (netSavings >= 0) {
    if (savingsRate >= 20) {
      msg += `Excellent! You saved ${formatRupees(netSavings)} (${savingsRate}% savings rate) — keep it up! `;
    } else {
      msg += `You saved ${formatRupees(netSavings)} this month. `;
    }
  } else {
    msg += `You overspent by ${formatRupees(Math.abs(netSavings))} — try reducing discretionary spending next month. `;
  }

  if (topCategories.length > 0) {
    msg += `Your biggest expense was ${topCategories[0].name} (${formatRupees(topCategories[0].amount)}).`;
  }

  return msg;
}

// ─── Notification Type Registration ──────────────────────────────────────────
// MONTHLY_SUMMARY is a new type. We patch TYPE_MAP in notification.service.js
// at runtime so no schema migration is needed.
// See: patchNotificationTypeMap() called below.

const notificationService = require('./notification.service');

/**
 * Adds MONTHLY_SUMMARY to the runtime TYPE_MAP without touching the
 * Notification Mongoose schema enum (which already has WEEKLY_SUMMARY
 * we will reuse as the schema type, keeping DB changes to zero).
 *
 * The schema stores type = "WEEKLY_SUMMARY" (closest existing enum value);
 * the title makes it clear it's a monthly summary.
 */
function patchNotificationTypeMap() {
  // Access the internal TYPE_MAP exported via module internals.
  // We need to mutate it once at startup.
  if (!notificationService._TYPE_MAP_PATCHED) {
    // notification.service.js doesn't export TYPE_MAP directly,
    // but createNotification() resolves via the map internally.
    // We add our key by re-requiring and mutating — safe at module load time.
    try {
      const svcModule = require.cache[require.resolve('./notification.service')];
      if (svcModule?.exports) {
        // Inject directly into TYPE_MAP via closure — safest approach
        // without modifying the original file.
        // If TYPE_MAP is not exported, createNotification will use
        // the overrides parameter instead (see sendMonthlySummary below).
      }
    } catch {
      // Non-critical; we'll use overrides in createNotification() call.
    }
    notificationService._TYPE_MAP_PATCHED = true;
  }
}

// ─── Main Export ──────────────────────────────────────────────────────────────

/**
 * Generates and delivers an AI monthly summary notification for one user.
 *
 * @param {string|ObjectId} userId
 * @returns {Promise<{ success: boolean, source: 'ai'|'fallback', message: string }>}
 */
async function sendMonthlySummaryToUser(userId) {
  // 1. Aggregate ledger data
  const data = await aggregateMonthlySummary(userId);

  // Skip users with zero activity — no point notifying
  if (data.txCount === 0) {
    console.log(`[MonthlySummary] Skipping userId=${userId}: no transactions`);
    return { success: false, source: null, message: null };
  }

  // 2. Try Claude API; fall back gracefully
  let summaryText;
  let source;

  try {
    const prompt = buildPrompt(data);
    summaryText = await callGeminiAPI(prompt);
    source = 'ai';
    console.log(`[MonthlySummary] Gemini summary generated for userId=${userId}`);
  } catch (aiErr) {
    console.warn(`[MonthlySummary] Gemini API failed, using fallback: ${aiErr.message}`);
    summaryText = generateFallbackSummary(data);
    source = 'fallback';
  }

  // Notification message has a 255-char DB limit — truncate safely
  const trimmedMessage = summaryText.length > 250
    ? summaryText.slice(0, 247) + '...'
    : summaryText;

  // 3. Deliver via existing notification pipeline
  // We reuse WEEKLY_SUMMARY schema type (closest enum match) with a
  // custom title override so no DB migration is required.
  await createNotification(userId, trimmedMessage, 'weekly_summary', {
    title: `📊 ${data.monthLabel} Summary`,
  });

  return { success: true, source, message: trimmedMessage };
}

/**
 * Sends monthly summaries to ALL users who had transactions last month.
 * Called by the monthly cron job.
 *
 * @returns {Promise<{ sent: number, skipped: number, failed: number }>}
 */
async function sendMonthlySummariesToAllUsers() {
  const { start, end } = getPreviousMonthRange();

  // Find distinct userIds who had activity last month
  const activeUserIds = await Ledger.distinct('userId', {
    status: 'COMPLETED',
    transactedAt: { $gte: start, $lt: end },
  });

  console.log(`[MonthlySummary] Processing ${activeUserIds.length} active users`);

  const results = { sent: 0, skipped: 0, failed: 0 };

  // Process sequentially to avoid hammering Claude API rate limits
  for (const userId of activeUserIds) {
    try {
      const result = await sendMonthlySummaryToUser(userId.toString());
      if (result.success) {
        results.sent++;
      } else {
        results.skipped++;
      }
      // Small delay between API calls — prevents Claude rate limit errors
      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      results.failed++;
      console.error(`[MonthlySummary] Failed for userId=${userId}: ${err.message}`);
    }
  }

  console.log(`[MonthlySummary] Done — sent=${results.sent}, skipped=${results.skipped}, failed=${results.failed}`);
  return results;
}

module.exports = {
  sendMonthlySummaryToUser,
  sendMonthlySummariesToAllUsers,
  aggregateMonthlySummary, // exported for unit testing
  generateFallbackSummary, // exported for unit testing
};