'use strict';

const mongoose = require('mongoose');
const Decimal = require('decimal.js');
const Account = require('../models/Account');
const Ledger = require('../models/ledger');
const { computeBalanceDelta, computeReversalDelta } = require('./ledgerDelta');

// ─── Constants ────────────────────────────────────────────────────────────────

// Any mismatch above this threshold is flagged MISMATCH_LARGE and skipped
// by autoCorrect. These require human review before touching.
const LARGE_MISMATCH_THRESHOLD = new Decimal('1000.00');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toDecimal128(decimalValue) {
  return mongoose.Types.Decimal128.fromString(decimalValue);
}

// ─── Core: recompute expected balances for one account ────────────────────────

/**
 * Fetches all COMPLETED ledger entries for the given account and replays them
 * in insertion order to derive the expected availableBalance and reservedBalance.
 *
 * Returns { expectedAvailable: Decimal, expectedReserved: Decimal }
 */
async function recomputeBalancesForAccount(accountId, userId, session = null) {
  // Fetch COMPLETED entries only — VOIDED, FAILED, and PENDING entries never
  // touched the cached balance and must not be included in the replay.
  const entries = await Ledger
    .find(
      { accountId, userId, status: 'COMPLETED' },
      {
        _id: 1,
        amount: 1,
        transactionType: 1,
        direction: 1,
        parentTransactionId: 1,
      }
    )
    .sort({ _id: 1 })   // _id is monotonically increasing (ObjectId = time-ordered)
    .session(session)
    .lean();

  // Pre-fetch all parent transactions referenced by REVERSAL entries in this
  // batch. We do one bulk fetch rather than N individual lookups.
  const reversalEntries = entries.filter((e) => e.direction === 'REVERSAL');
  const parentIds = reversalEntries
    .map((e) => e.parentTransactionId)
    .filter(Boolean);

  const parentMap = new Map();
  if (parentIds.length > 0) {
    const parents = await Ledger
      .find(
        { _id: { $in: parentIds } },
        { _id: 1, direction: 1, transactionType: 1 }
      )
      .session(session)
      .lean();
    for (const p of parents) {
      parentMap.set(p._id.toString(), p);
    }
  }

  let available = new Decimal(0);
  let reserved = new Decimal(0);

  for (const entry of entries) {
    let balanceChange, reservedChange;

    if (entry.direction === 'REVERSAL') {
      const parent = entry.parentTransactionId
        ? parentMap.get(entry.parentTransactionId.toString())
        : null;

      if (!parent) {
        // Parent is either missing or not in parentMap — cannot derive the
        // delta. This is a data integrity issue; skip and flag it so the
        // mismatch surfaces rather than producing a misleading OK.
        throw new Error(
          `reconciliation: REVERSAL entry ${entry._id} references parentTransactionId ` +
          `${entry.parentTransactionId} which was not found in the database.`
        );
      }

      // Reversal entries negate whatever the parent entry did.
      const amount = new Decimal(entry.amount.toString());
      ({ balanceChange, reservedChange } = computeReversalDelta(
        parent.direction,
        parent.transactionType,
        amount
      ));
    } else {
      const amount = new Decimal(entry.amount.toString());
      ({ balanceChange, reservedChange } = computeBalanceDelta(
        entry.direction,
        entry.transactionType,
        amount
      ));
    }

    available = available.plus(balanceChange);
    reserved = reserved.plus(reservedChange);
  }

  // Clamp to zero: a correctly operating system should never produce negatives,
  // but a corrupted history could. We clamp so the reconciliation result is
  // comparable to what the account's balance floor guards would allow.
  if (available.isNegative()) available = new Decimal(0);
  if (reserved.isNegative()) reserved = new Decimal(0);

  return { expectedAvailable: available, expectedReserved: reserved };
}

// ─── reconcileAccount ─────────────────────────────────────────────────────────

/**
 * Reconciles a single account.
 *
 * @param {ObjectId|string} accountId
 * @param {ObjectId|string} userId
 * @param {{ autoCorrect?: boolean, session?: ClientSession }} [opts]
 *
 * @returns {Promise<ReconciliationResult>}
 *
 * ReconciliationResult shape:
 * {
 *   accountId:         string,
 *   accountName:       string,
 *   status:            'OK' | 'MISMATCH' | 'MISMATCH_LARGE' | 'ERROR',
 *   cachedAvailable:   string,    // what the Account document holds
 *   cachedReserved:    string,
 *   expectedAvailable: string,    // what the ledger replay produces
 *   expectedReserved:  string,
 *   deltaAvailable:    string,    // expected − cached (positive = cache is under)
 *   deltaReserved:     string,
 *   corrected:         boolean,   // true only when autoCorrect wrote a fix
 *   error:             string | null,
 * }
 */
async function reconcileAccount(accountId, userId, opts = {}) {
  const { autoCorrect = false, session = null } = opts;

  const result = {
    accountId: accountId.toString(),
    accountName: '',
    status: 'ERROR',
    cachedAvailable: '0.00',
    cachedReserved: '0.00',
    expectedAvailable: '0.00',
    expectedReserved: '0.00',
    deltaAvailable: '0.00',
    deltaReserved: '0.00',
    corrected: false,
    error: null,
  };

  try {
    const account = await Account.findOne({ _id: accountId, userId })
      .session(session)
      .lean();

    if (!account) {
      result.error = 'Account not found';
      return result;
    }

    result.accountName = account.name;
    result.cachedAvailable = account.availableBalance?.toString() || '0.00';
    result.cachedReserved = account.reservedBalance?.toString() || '0.00';

    const { expectedAvailable, expectedReserved } =
      await recomputeBalancesForAccount(accountId, userId, session);

    result.expectedAvailable = expectedAvailable.toFixed(2);
    result.expectedReserved = expectedReserved.toFixed(2);

    const cachedAvail = new Decimal(result.cachedAvailable);
    const cachedResv = new Decimal(result.cachedReserved);

    const deltaAvail = expectedAvailable.minus(cachedAvail);
    const deltaResv = expectedReserved.minus(cachedResv);

    result.deltaAvailable = deltaAvail.toFixed(2);
    result.deltaReserved = deltaResv.toFixed(2);

    const hasMismatch =
      !deltaAvail.isZero() ||
      !deltaResv.isZero();

    if (!hasMismatch) {
      result.status = 'OK';

      // Always update lastReconciledAt and reconciliationStatus even on OK,
      // so we have an audit trail of when each account was last checked.
      await Account.updateOne(
        { _id: accountId },
        {
          $set: {
            reconciliationStatus: 'OK',
            lastReconciledAt: new Date(),
          },
        },
        session ? { session } : {}
      );

      return result;
    }

    // ── Mismatch detected ──────────────────────────────────────────────────
    const absDeltaAvail = deltaAvail.abs();
    const absDeltaResv = deltaResv.abs();
    const isLarge =
      absDeltaAvail.greaterThan(LARGE_MISMATCH_THRESHOLD) ||
      absDeltaResv.greaterThan(LARGE_MISMATCH_THRESHOLD);

    result.status = isLarge ? 'MISMATCH_LARGE' : 'MISMATCH';

    // Mark account as mismatched regardless of autoCorrect — the status
    // column should always reflect the reality discovered by reconciliation.
    await Account.updateOne(
      { _id: accountId },
      {
        $set: {
          reconciliationStatus: 'MISMATCH',
          lastReconciledAt: new Date(),
        },
      },
      session ? { session } : {}
    );

    // ── AutoCorrect ────────────────────────────────────────────────────────
    // Large mismatches are never auto-corrected — they require manual review.
    // The threshold is configurable via LARGE_MISMATCH_THRESHOLD above.
    if (autoCorrect && !isLarge) {
      const updateResult = await Account.updateOne(
        {
          _id: accountId,
          availableBalance: toDecimal128(new Decimal(result.cachedAvailable).toFixed(2)),
          reservedBalance: toDecimal128(new Decimal(result.cachedReserved).toFixed(2))
        },
        {
          $set: {
            availableBalance: toDecimal128(expectedAvailable.toFixed(2)),
            reservedBalance: toDecimal128(expectedReserved.toFixed(2)),
            reconciliationStatus: 'OK',
            lastReconciledAt: new Date(),
          },
        },
        session ? { session, isReconciliation: true } : { isReconciliation: true }
      );

      if (updateResult.modifiedCount === 0) {
        result.status = 'MISMATCH';
        result.corrected = false;
        result.error = 'Auto-correction aborted due to concurrent balance modification';
        return result;
      }

      result.corrected = true;
      result.status = 'MISMATCH'; // keep the original status so callers know a fix was needed
    }

    return result;

  } catch (error) {
    result.error = error.message;
    return result;
  }
}

// ─── reconcileUser ────────────────────────────────────────────────────────────

/**
 * Reconciles all non-closed accounts for a given user.
 *
 * Runs each account sequentially (not in parallel) to avoid saturating the
 * MongoDB connection pool when called from a scheduled job that iterates
 * over many users.
 *
 * @param {ObjectId|string} userId
 * @param {{ autoCorrect?: boolean }} [opts]
 *
 * @returns {Promise<ReconciliationResult[]>}
 */
async function reconcileUser(userId, opts = {}) {
  const accounts = await Account
    .find(
      { userId, status: { $ne: 'CLOSED' } },
      { _id: 1, name: 1 }
    )
    .lean();

  const results = [];

  for (const account of accounts) {
    const result = await reconcileAccount(account._id, userId, opts);
    results.push(result);
  }

  return results;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { reconcileAccount, reconcileUser };