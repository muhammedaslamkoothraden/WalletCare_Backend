'use strict';

const mongoose = require('mongoose');
const crypto = require('crypto');
const Decimal = require('decimal.js');
const Ledger = require('../models/Ledger');
const Account = require('../models/Account');
const { StringValidationError, assertString } = require('../helpers/sanitize');
const {
  sanitizeCategory,
  sanitizeOptionalDescription,
  sanitizeOptionalPartyName,
  parseAmount,
} = require('../helpers/transactionInput');
const { computeForwardDelta, computeUndoDelta } = require('./ledgerDelta');

// ─── Constants ────────────────────────────────────────────────────────────────

// These directions cannot be edited because they have a coupled leg
// (transfer has two accounts, reversal has a parent chain).
// Editing them would require coordinating multiple entries atomically —
// that is a separate, more complex flow.
const NON_EDITABLE_DIRECTIONS = new Set([
  'ACCOUNT_TRANSFER_IN',
  'ACCOUNT_TRANSFER_OUT',
  'REVERSAL',
  'EDIT_REPLACEMENT', // cannot edit a replacement — edit the original instead
]);

// What transactionTypes are valid for each direction
const VALID_DIRECTION_TYPE_COMBINATIONS = new Map([
  ['STANDARD', new Set(['INCOME', 'EXPENSE'])],
  ['GOAL_ALLOCATION', new Set(['EXPENSE'])],
  ['GOAL_DEALLOCATION', new Set(['INCOME'])],
  ['GOAL_COMPLETION', new Set(['EXPENSE'])],
  ['EDIT_REPLACEMENT', new Set(['INCOME', 'EXPENSE'])],
]);

const MAX_RETRIES = 3;

// ─── Typed error ──────────────────────────────────────────────────────────────

class EditTransactionError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.name = 'EditTransactionError';
    this.statusCode = statusCode;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toDecimal128(decimalValue) {
  // Using .toString() guarantees it works for both string literals and Decimal.js objects
  return mongoose.Types.Decimal128.fromString(decimalValue.toString());
}

// ─── Core service ─────────────────────────────────────────────────────────────

/**
 * Edits a ledger entry using the Void + New Entry pattern.
 *
 * Step 1 — Idempotency check
 * Step 2 — Load and validate the original entry
 * Step 3 — Load and guard the account
 * Step 4 — Compute undo delta (reverse the original)
 * Step 5 — Compute forward delta (apply the new values)
 * Step 6 — Validate net balance
 * Step 7 — Create the EDIT_REPLACEMENT entry
 * Step 8 — Void the original entry
 * Step 9 — Update cached account balance
 */
async function editTransaction(params) {
  const {
    userId,
    originalTxId,
    editIdempotencyKey,
    amount,
    transactionType,
    direction,
    category,
    description,
    partyName,
    transactedAt,
  } = params;

  // ── Input validation (before opening a session) ────────────────────────────

  // FIX: assertString throws StringValidationError which is re-thrown as
  // EditTransactionError(400) so the HTTP handler converts it to a 400
  // response. Previously this block incorrectly referenced `res`, which
  // does not exist in a pure service function — causing a ReferenceError
  // at runtime and a 500 response instead of a 400.
  let safeCategory, safeDescription, safePartyName, safeIdempotencyKey;
  try {
    safeIdempotencyKey = assertString(editIdempotencyKey, 'editIdempotencyKey', { maxLength: 114 });
    if (safeIdempotencyKey.length < 8) {
      throw new StringValidationError('editIdempotencyKey must be at least 8 characters');
    }
    safeCategory = sanitizeCategory(category);
    safeDescription = sanitizeOptionalDescription(description);
    safePartyName = sanitizeOptionalPartyName(partyName);
  } catch (err) {
    if (err instanceof StringValidationError) {
      throw new EditTransactionError(err.message, 400);
    }
    throw err;
  }

  if (!mongoose.Types.ObjectId.isValid(originalTxId)) {
    throw new EditTransactionError('Invalid originalTxId', 400);
  }

  if (NON_EDITABLE_DIRECTIONS.has(direction)) {
    throw new EditTransactionError(
      `Transactions with direction '${direction}' cannot be edited directly. ` +
      'Use a reversal and a new transaction instead.',
      400
    );
  }

  const allowedTypes = VALID_DIRECTION_TYPE_COMBINATIONS.get(direction);
  if (!allowedTypes) {
    throw new EditTransactionError(`Invalid direction: ${direction}`, 400);
  }
  if (!allowedTypes.has(transactionType)) {
    throw new EditTransactionError(
      `transactionType '${transactionType}' is not valid for direction '${direction}'. ` +
      `Allowed: ${[...allowedTypes].join(', ')}`,
      400
    );
  }

  let safeAmount;
  try {
    safeAmount = parseAmount(amount);
  } catch (e) {
    throw new EditTransactionError(
      e.message,
      400
    );
  }

  let parsedDateObj;
  if (transactedAt !== undefined && transactedAt !== null) {
    const candidate = new Date(transactedAt);
    if (isNaN(candidate.getTime())) {
      throw new EditTransactionError('transactedAt must be a valid date', 400);
    }
    parsedDateObj = candidate;
  } else {
    parsedDateObj = new Date();
  }

  // Deterministic sub-keys — client supplies one key, we derive both.
  // ':new'  → idempotency key for the replacement entry
  // ':void' → idempotency key stamped on the voided original
  const voidIdempotencyKey = crypto.createHash('sha256').update(`edit-void-leg:${safeIdempotencyKey}`).digest('hex');
  const newIdempotencyKey = crypto.createHash('sha256').update(`edit-new-leg:${safeIdempotencyKey}`).digest('hex');

  // ── Retry loop ─────────────────────────────────────────────────────────────

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {

      // ── Step 1: Idempotency check ────────────────────────────────────────
      // If ':new' exists the edit already completed — return cached result.
      // No need to check ':void' separately — both writes are atomic.
      const existingReplacement = await Ledger
        .findOne({ userId, idempotencyKey: newIdempotencyKey })
        .session(session)
        .lean();

      if (existingReplacement) {
        const account = await Account
          .findOne({ _id: existingReplacement.accountId, userId })
          .session(session)
          .lean();
        await session.abortTransaction();
        return {
          duplicate: true,
          originalTxId,
          replacementTxId: existingReplacement._id.toString(),
          availableBalance: account?.availableBalance?.toString() ?? '0.00',
          reservedBalance: account?.reservedBalance?.toString() ?? '0.00',
        };
      }

      // ── Step 2: Load and validate the original entry ─────────────────────
      const original = await Ledger
        .findOne({ _id: originalTxId, userId })
        .session(session); // non-lean — we call .save() on it later

      if (!original) {
        await session.abortTransaction();
        throw new EditTransactionError('Transaction not found', 404);
      }
      if (original.status !== 'COMPLETED') {
        await session.abortTransaction();
        throw new EditTransactionError(
          `Only COMPLETED transactions can be edited. This transaction is '${original.status}'.`,
          400
        );
      }
      if (NON_EDITABLE_DIRECTIONS.has(original.direction)) {
        await session.abortTransaction();
        throw new EditTransactionError(
          `Transactions with direction '${original.direction}' cannot be edited.`,
          400
        );
      }

      // ── Step 3: Load and guard the account ──────────────────────────────
      const account = await Account
        .findOne({ _id: original.accountId, userId })
        .session(session);

      if (!account) {
        await session.abortTransaction();
        throw new EditTransactionError('Account not found', 404);
      }
      if (account.status === 'CLOSED') {
        await session.abortTransaction();
        throw new EditTransactionError(
          'Transactions are not permitted on a closed account', 400
        );
      }
      if (account.status === 'FROZEN') {
        await session.abortTransaction();
        throw new EditTransactionError(
          'Transactions are not permitted on a frozen account', 400
        );
      }

      const currentAvailable = new Decimal(account.availableBalance.toString());
      const currentReserved = new Decimal(account.reservedBalance.toString());

      // ── Step 4: Undo delta ───────────────────────────────────────────────
      // Computes how much to add/subtract to reverse the original entry.
      const originalAmount = new Decimal(original.amount.toString());
      const { balanceChange: undoBalance, reservedChange: undoReserved } =
        computeUndoDelta(original.direction, original.transactionType, originalAmount);

      // ── Step 5: Forward delta ────────────────────────────────────────────
      // Computes how much to add/subtract to apply the new entry.
      const { balanceChange: newBalance, reservedChange: newReserved } =
        computeForwardDelta(direction, transactionType, safeAmount);

      // ── Step 6: Net balance ──────────────────────────────────────────────
      // Apply both deltas together — undo the old, apply the new.
      const netAvailable = currentAvailable.plus(undoBalance).plus(newBalance);
      const netReserved = currentReserved.plus(undoReserved).plus(newReserved);

      if (netAvailable.isNegative()) {
        await session.abortTransaction();
        throw new EditTransactionError('Insufficient available balance', 400);
      }
      if (netReserved.isNegative()) {
        await session.abortTransaction();
        throw new EditTransactionError('Insufficient reserved balance', 400);
      }

      // ── Step 7: Create replacement entry ────────────────────────────────
      // Created BEFORE voiding so that if new data fails validation,
      // the session rolls back with the original still COMPLETED.
      const [replacement] = await Ledger.create([{
        userId,
        accountId: original.accountId,
        goalId: original.goalId ?? null,
        amount: toDecimal128(safeAmount),
        transactionType,
        direction: 'EDIT_REPLACEMENT', // always set by system
        category: safeCategory,
        description: safeDescription,
        partyName: safePartyName,
        idempotencyKey: newIdempotencyKey,
        replacesTransactionId: original._id,       // back-pointer to original
        linkedAccountId: null,
        parentTransactionId: null,
        status: 'COMPLETED',
        transactedAt: parsedDateObj,
      }], { session });

      // ── Step 8: Void the original ────────────────────────────────────────
      // Pre-save middleware validates COMPLETED → VOIDED via VALID_TRANSITIONS.
      // idempotencyKey is updated to ':void' sub-key so concurrent void
      // attempts surface a clean duplicate-key error instead of a 500.
      //
      // ⚠️ IMPORTANT: This requires removing 'idempotencyKey' from
      // IMMUTABLE_FIELDS in ledger.js, since we are mutating it here.
      original.status = 'VOIDED';
      original.idempotencyKey = voidIdempotencyKey;
      await original.save({ session });

      // ── Step 9: Update cached account balance ────────────────────────────
      account.availableBalance = toDecimal128(netAvailable);
      account.reservedBalance = toDecimal128(netReserved);
      await account.save({ session });

      await session.commitTransaction();

      return {
        duplicate: false,
        originalTxId: original._id.toString(),
        replacementTxId: replacement._id.toString(),
        availableBalance: netAvailable.toString(),
        reservedBalance: netReserved.toString(),
      };

    } catch (error) {
      if (session.inTransaction()) await session.abortTransaction().catch(() => { });

      // Typed errors — re-throw immediately, no retry
      if (error instanceof EditTransactionError) throw error;

      const isVersionError = error.name === 'VersionError';
      const isWriteConflict = error.code === 112 ||
        error.hasErrorLabel?.('TransientTransactionError');

      if ((isVersionError || isWriteConflict) && attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, Math.random() * 50 * attempt));
        continue;
      }

      // Duplicate key errors
      if (error.code === 11000) {
        // one_edit_per_original index fired — already edited
        if (error.message?.includes('one_edit_per_original')) {
          throw new EditTransactionError(
            'This transaction has already been edited',
            409
          );
        }

        // Race on idempotencyKey — fetch and return the winner
        try {
          const existing = await Ledger
            .findOne({ userId, idempotencyKey: newIdempotencyKey })
            .lean();
          if (existing) {
            const account = await Account
              .findOne({ _id: existing.accountId, userId })
              .lean();
            return {
              duplicate: true,
              originalTxId,
              replacementTxId: existing._id.toString(),
              availableBalance: account?.availableBalance?.toString() ?? '0.00',
              reservedBalance: account?.reservedBalance?.toString() ?? '0.00',
            };
          }
        } catch (_) { }
      }

      throw error;

    } finally {
      session.endSession();
    }
  }
}

// ─── HTTP handler ─────────────────────────────────────────────────────────────

exports.editTransaction = async (req, res, next) => {
  const userId = req.user.id;
  const { originalTxId } = req.params;
  const {
    editIdempotencyKey,
    amount,
    transactionType,
    direction,
    category,
    description,
    partyName,
    transactedAt,
  } = req.body;

  // ── Required field fast-exit ───────────────────────────────────────────────
  const missingField = [
    'editIdempotencyKey', 'amount', 'transactionType', 'direction', 'category',
  ].find((f) => !req.body[f]);

  if (missingField) {
    return res.status(400).json({ success: false, message: `${missingField} is required` });
  }

  try {
    // FIX: Pass raw values for description and partyName — do not pre-process
    // with ?.trim() || null here. The service's assertString handles trimming,
    // type checking, and control character stripping. Pre-trimming with optional
    // chaining bypasses the type check: { "$gt": "" }.trim() throws TypeError
    // which becomes a 500 instead of a 400.
    const result = await editTransaction({
      userId,
      originalTxId,
      editIdempotencyKey,
      amount,
      transactionType,
      direction,
      category,
      description,
      partyName,
      transactedAt,
    });

    const status = result.duplicate ? 409 : 201;
    return res.status(status).json({ success: true, data: result });

  } catch (error) {
    if (error instanceof EditTransactionError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    next(error);
  }
};

exports.EditTransactionError = EditTransactionError;
exports._editTransaction = editTransaction; // exported for unit tests