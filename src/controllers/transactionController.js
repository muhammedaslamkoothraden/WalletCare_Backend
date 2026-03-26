'use strict';

const mongoose = require('mongoose');
const Decimal = require('decimal.js');
const Ledger = require('../models/ledger');
const Account = require('../models/Account');
const { assertString, StringValidationError } = require('../helpers/sanitize');
const {
  sanitizeCategory,
  sanitizeOptionalDescription,
  parseAmount,
} = require('../helpers/transactionInput');

const { initiateTransfer, TransferError } = require('../services/accountTransfer');
const editTransactionService = require('../services/Edittransaction');
const { computeBalanceDelta, computeReversalDelta } = require('../services/ledgerDelta');

// ─── Constants ────────────────────────────────────────────────────────────────

const TRANSFER_DIRECTIONS = Object.freeze(new Set([
  'ACCOUNT_TRANSFER_IN',
  'ACCOUNT_TRANSFER_OUT',
]));

const VALID_TRANSACTION_TYPES = Object.freeze(new Set([
  'INCOME', 'EXPENSE', 'TRANSFER', 'REVERSAL',
]));

const VALID_DIRECTIONS = Object.freeze(new Set([
  'STANDARD', 'GOAL_ALLOCATION', 'GOAL_DEALLOCATION',
  'GOAL_COMPLETION', 'ACCOUNT_TRANSFER_IN', 'ACCOUNT_TRANSFER_OUT', 'REVERSAL',
]));

const VALID_DIRECTION_TYPE_COMBINATIONS = Object.freeze(
  new Map([
    ['STANDARD', Object.freeze(new Set(['INCOME', 'EXPENSE']))],
    ['GOAL_ALLOCATION', Object.freeze(new Set(['EXPENSE']))],
    ['GOAL_DEALLOCATION', Object.freeze(new Set(['INCOME']))],
    ['GOAL_COMPLETION', Object.freeze(new Set(['EXPENSE']))],
    ['ACCOUNT_TRANSFER_OUT', Object.freeze(new Set(['TRANSFER']))],
    ['ACCOUNT_TRANSFER_IN', Object.freeze(new Set(['TRANSFER']))],
    ['REVERSAL', Object.freeze(new Set(['REVERSAL']))],
  ])
);

const REQUIRED_FIELDS = Object.freeze([
  'accountId', 'amount', 'transactionType',
  'direction', 'category', 'idempotencyKey',
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function errRes(res, status, message) {
  return res.status(status).json({ success: false, error: message });
}

function toDecimal128(decimalValue) {
  return mongoose.Types.Decimal128.fromString(decimalValue);
}

function duplicateResponse(res, ledgerDoc, accountDoc) {
  return res.status(409).json({
    success: true,
    duplicate: true,
    txid: ledgerDoc._id,
    availableBalance: accountDoc?.availableBalance?.toString() ?? '0.00',
    reservedBalance: accountDoc?.reservedBalance?.toString() ?? '0.00',
  });
}

// ─── 1. processTransaction (Hardened with Retry Loop) ─────────────────────────

exports.processTransaction = async (req, res, next) => {
  const userId = req.user.id;

  // ── Step 1: Input Isolation & Strict Sanitization ──────────────────────────
  let input;
  try {
    const missingField = REQUIRED_FIELDS.find((f) => !req.body[f]);
    if (missingField) throw new Error(`${missingField} is required`);

    input = {
      accountId: req.body.accountId,
      amount: parseAmount(req.body.amount),
      transactionType: req.body.transactionType,
      direction: req.body.direction,
      category: sanitizeCategory(req.body.category),
      description: sanitizeOptionalDescription(req.body.description),
      idempotencyKey: assertString(req.body.idempotencyKey, 'idempotencyKey', { maxLength: 128 }),
      parentTransactionId: req.body.parentTransactionId,
      linkedAccountId: req.body.linkedAccountId,
    };

    if (input.idempotencyKey.length < 8) {
      throw new StringValidationError('idempotencyKey must be at least 8 characters');
    }
  } catch (error) {
    return errRes(res, 400, error.message);
  }

  const {
    accountId, amount: safeAmount, transactionType, direction, category: safeCategory,
    description: safeDescription, idempotencyKey, parentTransactionId, linkedAccountId
  } = input;

  // ── Step 2: Structural validation ─────────────────────────────────────────
  if (!mongoose.Types.ObjectId.isValid(accountId))
    return errRes(res, 400, 'Invalid accountId');
  if (linkedAccountId && !mongoose.Types.ObjectId.isValid(linkedAccountId))
    return errRes(res, 400, 'Invalid linkedAccountId');
  if (parentTransactionId && !mongoose.Types.ObjectId.isValid(parentTransactionId))
    return errRes(res, 400, 'Invalid parentTransactionId');

  if (!VALID_DIRECTIONS.has(direction))
    return errRes(res, 400, `Invalid direction: ${direction}`);
  if (!VALID_TRANSACTION_TYPES.has(transactionType))
    return errRes(res, 400, `Invalid transactionType: ${transactionType}`);

  const allowedTypes = VALID_DIRECTION_TYPE_COMBINATIONS.get(direction);
  if (!allowedTypes.has(transactionType)) {
    return errRes(res, 400, `transactionType '${transactionType}' is not valid for direction '${direction}'. Allowed: ${[...allowedTypes].join(', ')}`);
  }

  if (TRANSFER_DIRECTIONS.has(direction) && !linkedAccountId) {
    return errRes(res, 400, `direction '${direction}' requires linkedAccountId`);
  }

  if (linkedAccountId && accountId.toString() === linkedAccountId.toString()) {
    return errRes(res, 400, 'accountId and linkedAccountId must not be the same account');
  }

  if (direction === 'REVERSAL' && !parentTransactionId) {
    return errRes(res, 400, 'parentTransactionId is required for REVERSAL');
  }

  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // ── Idempotency check ────────────────────────────────────────────────
      const existingLedger = await Ledger
        .findOne({ userId, idempotencyKey })
        .session(session)
        .lean();
      if (existingLedger) {
        const account = await Account
          .findOne({ _id: existingLedger.accountId, userId })
          .session(session)
          .lean();
        await session.abortTransaction();
        return duplicateResponse(res, existingLedger, account);
      }

      // ── Account fetch & guards ───────────────────────────────────────────
      const account = await Account.findOne({ _id: accountId, userId }).session(session);

      if (!account) {
        await session.abortTransaction();
        return errRes(res, 404, 'Account not found');
      }
      if (account.status === 'CLOSED') {
        await session.abortTransaction();
        return errRes(res, 400, 'Transactions are not permitted on a closed account');
      }
      if (account.status === 'FROZEN') {
        await session.abortTransaction();
        return errRes(res, 400, 'Transactions are not permitted on a frozen account');
      }

      // ── Reversal validation ──────────────────────────────────────────────
      let parentTx = null;

      if (direction === 'REVERSAL') {
        parentTx = await Ledger
          .findOne({ _id: parentTransactionId, userId, accountId })
          .session(session)
          .lean();

        if (!parentTx) {
          await session.abortTransaction();
          return errRes(res, 404, 'Parent transaction not found');
        }
        if (parentTx.status !== 'COMPLETED') {
          await session.abortTransaction();
          return errRes(res, 400, `Cannot reverse a transaction with status '${parentTx.status}'`);
        }

        const parentAmount = new Decimal(parentTx.amount.toString());
        if (!new Decimal(safeAmount).equals(parentAmount)) {
          await session.abortTransaction();
          return errRes(res, 400,
            `Reversal amount (${safeAmount}) must match original transaction amount (${parentAmount.toFixed(2)})`
          );
        }

        // Soft check: early exit with a clear message before the DB write.
        // The hard guarantee is the partial unique index
        // { parentTransactionId, direction: 'REVERSAL' } on the Ledger schema.
        const alreadyReversed = await Ledger
          .findOne({ parentTransactionId, direction: 'REVERSAL', userId })
          .session(session)
          .lean();
        if (alreadyReversed) {
          await session.abortTransaction();
          return errRes(res, 409, 'This transaction has already been reversed');
        }
      }

      // ── Balance delta computation ────────────────────────────────────────
      const currentAvailable = new Decimal(account.availableBalance.toString());
      const currentReserved = new Decimal(account.reservedBalance.toString());

      let balanceChange, reservedChange;

      if (direction === 'REVERSAL') {
        ({ balanceChange, reservedChange } = computeReversalDelta(
          parentTx.direction, parentTx.transactionType, safeAmount
        ));
      } else {
        ({ balanceChange, reservedChange } = computeBalanceDelta(direction, transactionType, safeAmount));
      }

      const newAvailable = currentAvailable.plus(balanceChange);
      const newReserved = currentReserved.plus(reservedChange);

      if (newAvailable.isNegative()) {
        await session.abortTransaction();
        return errRes(res, 400, 'Insufficient available balance');
      }
      if (newReserved.isNegative()) {
        await session.abortTransaction();
        return errRes(res, 400, 'Insufficient reserved balance');
      }

      // ── Write ledger entry ───────────────────────────────────────────────
      const [newLedger] = await Ledger.create([{
        userId,
        accountId,
        amount: toDecimal128(safeAmount),
        transactionType,
        direction,
        category: safeCategory,
        description: safeDescription,
        idempotencyKey,
        linkedAccountId: linkedAccountId || null,
        parentTransactionId: parentTransactionId || null,
        status: 'COMPLETED',
      }], { session });

      // ── Update cached account balance ────────────────────────────────────
      account.availableBalance = toDecimal128(newAvailable);
      account.reservedBalance = toDecimal128(newReserved);
      await account.save({ session });

      await session.commitTransaction();

      return res.status(201).json({
        success: true,
        txid: newLedger._id,
        availableBalance: newAvailable.toFixed(2),
        reservedBalance: newReserved.toFixed(2),
      });

    } catch (error) {
      if (session.inTransaction()) await session.abortTransaction().catch(() => { });

      const isVersionError = error.name === 'VersionError';
      const isWriteConflict = error.code === 112 || error.hasErrorLabel?.('TransientTransactionError');

      if ((isVersionError || isWriteConflict) && attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, Math.random() * 50 * attempt));
        continue;
      }

      // ── Idempotency key collision on concurrent write ──────────────────
      if (error.code === 11000) {
        // Check for the double-reversal case specifically — the unique partial
        // index on { parentTransactionId, direction: 'REVERSAL' } will also
        // surface as an 11000. We handle both here.
        if (error.message?.includes('one_reversal_per_parent')) {
          return errRes(res, 409, 'This transaction has already been reversed');
        }

        try {
          const existing = await Ledger.findOne({ userId, idempotencyKey }).lean();
          if (existing) {
            const account = await Account
              .findOne({ _id: existing.accountId, userId })
              .lean();
            return duplicateResponse(res, existing, account);
          }
        } catch (_) { }

        return res.status(409).json({
          success: true,
          duplicate: true,
          txid: null,
          availableBalance: '0.00',
          reservedBalance: '0.00',
        });
      }

      return next(error);
    } finally {
      session.endSession();
    }
  }
};

// ─── 2. accountTransfer (Thin HTTP Handler) ───────────────────────────────────

exports.accountTransfer = async (req, res, next) => {
  const userId = req.user.id;

  // ── Step 1: Input Isolation & Strict Sanitization ──────────────────────────
  let input;
  try {
    const missing = ['fromAccountId', 'toAccountId', 'amount', 'category', 'idempotencyKey']
      .find((f) => !req.body[f]);
    if (missing) throw new Error(`${missing} is required`);

    input = {
      fromAccountId: req.body.fromAccountId,
      toAccountId: req.body.toAccountId,
      amount: parseAmount(req.body.amount),
      category: sanitizeCategory(req.body.category),
      description: sanitizeOptionalDescription(req.body.description),
      idempotencyKey: assertString(req.body.idempotencyKey, 'idempotencyKey', { maxLength: 128 }),
    };

    if (input.idempotencyKey.length < 8) {
      throw new StringValidationError('idempotencyKey must be at least 8 characters');
    }
  } catch (error) {
    return errRes(res, 400, error.message);
  }

  const {
    fromAccountId, toAccountId, amount: safeAmount,
    category: safeCategory, description: safeDescription, idempotencyKey
  } = input;

  // ── Step 2: ObjectId validation ───────────────────────────────────────────
  if (!mongoose.Types.ObjectId.isValid(fromAccountId))
    return errRes(res, 400, 'Invalid fromAccountId');
  if (!mongoose.Types.ObjectId.isValid(toAccountId))
    return errRes(res, 400, 'Invalid toAccountId');

  if (fromAccountId.toString() === toAccountId.toString()) {
    return errRes(res, 400, 'fromAccountId and toAccountId must not be the same account');
  }

  try {
    const result = await initiateTransfer({
      userId,
      fromAccountId,
      toAccountId,
      safeAmount,
      category: safeCategory,
      idempotencyKey,
      description: safeDescription,
    });

    if (result.duplicate) return res.status(409).json({ success: true, ...result });
    return res.status(201).json({ success: true, ...result });

  } catch (error) {
    if (error instanceof TransferError) {
      return errRes(res, error.statusCode, error.message);
    }
    next(error);
  }
};

// ─── 3. getHistory ────────────────────────────────────────────────────────────

exports.getHistory = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { accountId, category, limit = 20, lastId } = req.query;

    // Base filter: always scope to the authenticated user.
    const query = { userId: new mongoose.Types.ObjectId(userId) };

    if (accountId) {
      if (!mongoose.Types.ObjectId.isValid(accountId))
        return errRes(res, 400, 'Invalid accountId');

      // Verify the account belongs to this user before filtering by it.
      // Without this check, querying an accountId that belongs to another user
      // returns an empty array — leaking that the account does or does not exist.
      const accountExists = await Account.exists({ _id: accountId, userId });
      if (!accountExists) return errRes(res, 404, 'Account not found');

      query.accountId = new mongoose.Types.ObjectId(accountId);
    }

    // ── Sanitize category query param ──────────────────────────────────────
    // Query params carry the same injection risk as body params.
    // assertString rejects non-strings, trims, and strips control characters.
    if (category) {
      let safeCategory;
      try {
        safeCategory = assertString(category, 'category', { maxLength: 50 });
      } catch (err) {
        if (err instanceof StringValidationError) return errRes(res, 400, err.message);
        throw err;
      }
      query.category = safeCategory;
    }

    if (lastId) {
      if (!mongoose.Types.ObjectId.isValid(lastId))
        return errRes(res, 400, 'Invalid lastId cursor');
      query._id = { $lt: new mongoose.Types.ObjectId(lastId) };
    }

    const parsed = parseInt(limit, 10);
    const parsedLimit = Math.min(isNaN(parsed) || parsed < 1 ? 20 : parsed, 100);

    const history = await Ledger.find(query)
      .populate('accountId', 'name')
      .sort({ _id: -1 })
      .limit(parsedLimit)
      .lean();

    return res.status(200).json({
      success: true,
      count: history.length,
      nextCursor: history.length === parsedLimit ? history.at(-1)._id : null,
      data: history.map((tx) => ({
        ...tx,
        amount: tx.amount.toString(),
        accountName: tx.accountId?.name || 'Unknown Account',
      })),
    });
  } catch (error) {
    next(error);
  }
};

// ─── 4. editTransaction ─────────────────────────────────────────────────────
exports.editTransaction = async (req, res, next) => {
  return editTransactionService.editTransaction(req, res, next);
};