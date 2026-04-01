'use strict';

const mongoose = require('mongoose');
const Decimal = require('decimal.js');
const Ledger = require('../models/ledger'); // Adjusted to standard capitalization
const Account = require('../models/Account');
const Goal = require('../models/Goal'); // 🔥 ADDED: Import Goal model
const { assertString, StringValidationError } = require('../helpers/sanitize');
const {
  sanitizeCategory,
  sanitizeOptionalDescription,
  parseAmount,
} = require('../helpers/transactionInput');

const { initiateTransfer, TransferError } = require('../services/accountTransfer');
const { computeBalanceDelta, computeReversalDelta } = require('../services/ledgerDelta');
const { reconcileAccount } = require('../services/reconciliation');

// ─── Constants ────────────────────────────────────────────────────────────────

const TRANSFER_DIRECTIONS = Object.freeze(new Set([
  'ACCOUNT_TRANSFER_IN',
  'ACCOUNT_TRANSFER_OUT',
]));

const VALID_TRANSACTION_TYPES = Object.freeze(new Set([
  'INCOME', 'EXPENSE', 'TRANSFER', 'REVERSAL',
]));

const VALID_DIRECTIONS = Object.freeze(new Set([
  'STANDARD',
  'GOAL_ALLOCATION',
  'GOAL_DEALLOCATION',
  'GOAL_COMPLETION',
  'ACCOUNT_TRANSFER_IN',
  'ACCOUNT_TRANSFER_OUT',
  'REVERSAL',
]));

const VALID_DIRECTION_TYPE_COMBINATIONS = Object.freeze(
  new Map([
    ['STANDARD',             Object.freeze(new Set(['INCOME', 'EXPENSE']))],
    ['GOAL_ALLOCATION',      Object.freeze(new Set(['EXPENSE', 'TRANSFER']))], // Adjusted to allow transfer if needed
    ['GOAL_DEALLOCATION',    Object.freeze(new Set(['INCOME', 'TRANSFER']))],
    ['GOAL_COMPLETION',      Object.freeze(new Set(['EXPENSE']))],
    ['ACCOUNT_TRANSFER_OUT', Object.freeze(new Set(['TRANSFER']))],
    ['ACCOUNT_TRANSFER_IN',  Object.freeze(new Set(['TRANSFER']))],
    ['REVERSAL',             Object.freeze(new Set(['REVERSAL']))],
  ])
);

const REQUIRED_FIELDS = Object.freeze([
  'accountId', 'amount', 'transactionType',
  'direction', 'category', 'idempotencyKey',
]);

const VALID_STATUSES = Object.freeze(new Set([
  'PENDING', 'COMPLETED', 'FAILED', 'VOIDED',
]));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function errRes(res, status, message) {
  return res.status(status).json({ success: false, error: message });
}

const toDecimal128 = (value) => {
  if (value === null || value === undefined) {
    return mongoose.Types.Decimal128.fromString('0');
  }
  return mongoose.Types.Decimal128.fromString(value.toString());
};

function duplicateResponse(res, ledgerDoc, accountDoc) {
  return res.status(409).json({
    success:          true,
    duplicate:        true,
    txid:             ledgerDoc._id,
    availableBalance: accountDoc?.availableBalance?.toString() ?? '0.00',
    reservedBalance:  accountDoc?.reservedBalance?.toString()  ?? '0.00',
  });
}

function reconcileAfterTransaction(accountId, userId) {
  reconcileAccount(accountId, userId, { autoCorrect: true })
    .then((result) => {
      if (result.status === 'OK') return;
      console.warn('[reconcileAfterTransaction] Mismatch detected', {
        accountId:      result.accountId,
        accountName:    result.accountName,
        status:         result.status,
        deltaAvailable: result.deltaAvailable,
        deltaReserved:  result.deltaReserved,
        corrected:      result.corrected,
        error:          result.error,
      });
    })
    .catch((err) => {
      console.error('[reconcileAfterTransaction] Unexpected error', { accountId, userId, error: err.message });
    });
}

// ─── 1. processTransaction ────────────────────────────────────────────────────

exports.processTransaction = async (req, res, next) => {
  const userId = req.user.id;

  let input;
  try {
    const missingField = REQUIRED_FIELDS.find((f) => !req.body[f]);
    if (missingField) throw new Error(`${missingField} is required`);

    input = {
      accountId:           req.body.accountId,
      amount:              parseAmount(req.body.amount),
      transactionType:     req.body.transactionType,
      direction:           req.body.direction,
      category:            sanitizeCategory(req.body.category),
      description:         sanitizeOptionalDescription(req.body.description),
      idempotencyKey:      assertString(req.body.idempotencyKey, 'idempotencyKey', { maxLength: 128 }),
      linkedAccountId:     req.body.linkedAccountId,
      transactedAt:        req.body.transactedAt,
      parentTransactionId: req.body.parentTransactionId ?? null,
    };

    if (input.idempotencyKey.length < 8) {
      throw new StringValidationError('idempotencyKey must be at least 8 characters');
    }
    if (input.transactedAt !== undefined && input.transactedAt !== null) {
      if (isNaN(new Date(req.body.transactedAt).getTime())) throw new Error('transactedAt must be a valid date');
    }
  } catch (error) {
    return errRes(res, 400, error.message);
  }

  const {
    accountId, amount: safeAmount, transactionType, direction,
    category: safeCategory, description: safeDescription,
    idempotencyKey, linkedAccountId, transactedAt, parentTransactionId,
  } = input;

  if (!mongoose.Types.ObjectId.isValid(accountId)) return errRes(res, 400, 'Invalid accountId');
  if (linkedAccountId && !mongoose.Types.ObjectId.isValid(linkedAccountId)) return errRes(res, 400, 'Invalid linkedAccountId');
  if (parentTransactionId && !mongoose.Types.ObjectId.isValid(parentTransactionId)) return errRes(res, 400, 'Invalid parentTransactionId');
  if (!VALID_DIRECTIONS.has(direction)) return errRes(res, 400, `Invalid direction: ${direction}`);
  if (!VALID_TRANSACTION_TYPES.has(transactionType)) return errRes(res, 400, `Invalid transactionType: ${transactionType}`);

  const allowedTypes = VALID_DIRECTION_TYPE_COMBINATIONS.get(direction);
  if (!allowedTypes.has(transactionType)) {
    return errRes(res, 400, `transactionType '${transactionType}' is not valid for direction '${direction}'. Allowed: ${[...allowedTypes].join(', ')}`);
  }

  if (TRANSFER_DIRECTIONS.has(direction) && !linkedAccountId) return errRes(res, 400, `direction '${direction}' requires linkedAccountId`);
  if (linkedAccountId && accountId.toString() === linkedAccountId.toString()) return errRes(res, 400, 'accountId and linkedAccountId must not be the same account');
  if (direction === 'REVERSAL' && !parentTransactionId) return errRes(res, 400, 'parentTransactionId is required for REVERSAL');

  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const existingLedger = await Ledger.findOne({ userId, idempotencyKey }).session(session).lean();
      if (existingLedger) {
        const account = await Account.findOne({ _id: existingLedger.accountId, userId }).session(session).lean();
        await session.abortTransaction();
        return duplicateResponse(res, existingLedger, account);
      }

      const account = await Account.findOne({ _id: accountId, userId }).session(session);
      if (!account) {
        await session.abortTransaction();
        return errRes(res, 404, 'Account not found');
      }
      if (account.status === 'CLOSED' || account.status === 'FROZEN') {
        await session.abortTransaction();
        return errRes(res, 400, `Transactions are not permitted on a ${account.status.toLowerCase()} account`);
      }

      let parentTx = null;

      if (direction === 'REVERSAL') {
        parentTx = await Ledger.findOne({ _id: parentTransactionId, userId, accountId }).session(session).lean();
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
          return errRes(res, 400, `Reversal amount (${safeAmount}) must match original amount (${parentAmount.toFixed(2)})`);
        }

        const alreadyReversed = await Ledger.findOne({ parentTransactionId, direction: 'REVERSAL', userId }).session(session).lean();
        if (alreadyReversed) {
          await session.abortTransaction();
          return errRes(res, 409, 'This transaction has already been reversed');
        }
      }

      const currentAvailable = new Decimal(account.availableBalance.toString());
      const currentReserved  = new Decimal(account.reservedBalance.toString());
      let balanceChange, reservedChange;

      if (direction === 'REVERSAL') {
        ({ balanceChange, reservedChange } = computeReversalDelta(parentTx.direction, parentTx.transactionType, safeAmount));
      } else {
        ({ balanceChange, reservedChange } = computeBalanceDelta(direction, transactionType, safeAmount));
      }

      const newAvailable = currentAvailable.plus(balanceChange);
      const newReserved  = currentReserved.plus(reservedChange);

      if (newAvailable.isNegative()) {
        await session.abortTransaction();
        return errRes(res, 400, 'Insufficient available balance');
      }
      if (newReserved.isNegative()) {
        await session.abortTransaction();
        return errRes(res, 400, 'Insufficient reserved balance');
      }

      // 🔥 UPDATE: Maintain goalId linkage on Reversal
      const [newLedger] = await Ledger.create([{
        userId,
        accountId,
        goalId:              direction === 'REVERSAL' && parentTx.goalId ? parentTx.goalId : null,
        amount:              toDecimal128(safeAmount),
        transactionType,
        direction,
        category:            safeCategory,
        description:         safeDescription,
        idempotencyKey,
        linkedAccountId:     linkedAccountId || null,
        parentTransactionId: parentTransactionId || null,
        status:              'COMPLETED',
        transactedAt:        transactedAt ? new Date(transactedAt) : new Date(),
        runningBalance:      toDecimal128(newAvailable),
      }], { session });

      account.availableBalance = toDecimal128(newAvailable);
      account.reservedBalance  = toDecimal128(newReserved);
      await account.save({ session });

      // 🔥 UPDATE: Sync Goal Balance during Reversal
      if (direction === 'REVERSAL' && parentTx && parentTx.goalId) {
        const goal = await Goal.findOne({ _id: parentTx.goalId, userId }).session(session);
        if (goal) {
          const amt = parseFloat(safeAmount.toString());
          if (parentTx.direction === 'GOAL_ALLOCATION') {
            // Reversing a deposit -> reduce goal savings
            goal.currentAmount -= amt;
            if (goal.currentAmount < goal.targetAmount) goal.status = 'active';
          } else if (parentTx.direction === 'GOAL_DEALLOCATION') {
            // Reversing a withdrawal -> increase goal savings
            goal.currentAmount += amt;
            if (goal.currentAmount >= goal.targetAmount) goal.status = 'completed';
          }
          await goal.save({ session });
        }
      }

      await session.commitTransaction();
      reconcileAfterTransaction(accountId, userId);

      return res.status(201).json({
        success:          true,
        txid:             newLedger._id,
        availableBalance: newAvailable.toFixed(2),
        reservedBalance:  newReserved.toFixed(2),
      });

    } catch (error) {
      if (session.inTransaction()) await session.abortTransaction().catch(() => {});
      const isVersionError  = error.name === 'VersionError';
      const isWriteConflict = error.code === 112 || error.hasErrorLabel?.('TransientTransactionError');

      if ((isVersionError || isWriteConflict) && attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, Math.random() * 50 * attempt));
        continue;
      }
      if (error.code === 11000) return errRes(res, 409, 'Duplicate transaction detected');
      return next(error);
    } finally {
      session.endSession();
    }
  }
};

// ─── 2. accountTransfer ───────────────────────────────────────────────────────
// (Remains Unchanged)

exports.accountTransfer = async (req, res, next) => {
  // ... (Your existing accountTransfer code remains exactly the same)
  // Included below just for completeness so you can copy/paste the file
  const userId = req.user.id;
  let input;
  try {
    const missing = ['fromAccountId', 'toAccountId', 'amount', 'category', 'idempotencyKey'].find((f) => !req.body[f]);
    if (missing) throw new Error(`${missing} is required`);

    input = {
      fromAccountId:  req.body.fromAccountId,
      toAccountId:    req.body.toAccountId,
      amount:         parseAmount(req.body.amount),
      category:       sanitizeCategory(req.body.category),
      description:    sanitizeOptionalDescription(req.body.description),
      idempotencyKey: assertString(req.body.idempotencyKey, 'idempotencyKey', { maxLength: 128 }),
      transactedAt:   req.body.transactedAt,
    };

    if (input.idempotencyKey.length < 8) throw new StringValidationError('idempotencyKey must be at least 8 characters');
  } catch (error) {
    return errRes(res, 400, error.message);
  }

  const { fromAccountId, toAccountId, amount: safeAmount, category: safeCategory, description: safeDescription, idempotencyKey, transactedAt } = input;

  if (!mongoose.Types.ObjectId.isValid(fromAccountId)) return errRes(res, 400, 'Invalid fromAccountId');
  if (!mongoose.Types.ObjectId.isValid(toAccountId)) return errRes(res, 400, 'Invalid toAccountId');
  if (fromAccountId.toString() === toAccountId.toString()) return errRes(res, 400, 'fromAccountId and toAccountId must not be the same account');

  try {
    const result = await initiateTransfer({
      userId, fromAccountId, toAccountId, safeAmount,
      category: safeCategory, idempotencyKey, description: safeDescription, transactedAt,
    });
    if (result.duplicate) return res.status(409).json({ success: true, ...result });

    reconcileAfterTransaction(fromAccountId, userId);
    reconcileAfterTransaction(toAccountId,   userId);

    return res.status(201).json({ success: true, ...result });
  } catch (error) {
    if (error instanceof TransferError) return errRes(res, error.statusCode, error.message);
    next(error);
  }
};

// ─── 3. getHistory ────────────────────────────────────────────────────────────
// (Remains Unchanged)

exports.getHistory = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { accountId, category, limit = 20, lastId, status, startDate, endDate } = req.query;

    const query = { userId: new mongoose.Types.ObjectId(userId) };
    query.status = VALID_STATUSES.has(status) ? status : 'COMPLETED';

    if (accountId) {
      if (!mongoose.Types.ObjectId.isValid(accountId)) return errRes(res, 400, 'Invalid accountId');
      query.accountId = new mongoose.Types.ObjectId(accountId);
    }

    if (startDate || endDate) {
      query.transactedAt = {};
      if (startDate) query.transactedAt.$gte = new Date(startDate);
      if (endDate) query.transactedAt.$lte = new Date(endDate);
    }
    if (category) query.category = sanitizeCategory(category);

    if (lastId) {
      const lastTx = await Ledger.findById(lastId).select('transactedAt').lean();
      if (lastTx) {
        query.$or = [
          { transactedAt: { $lt: lastTx.transactedAt } },
          { transactedAt: lastTx.transactedAt, _id: { $lt: new mongoose.Types.ObjectId(lastId) } },
        ];
      }
    }

    const reversalScope = accountId 
        ? { userId: new mongoose.Types.ObjectId(userId), accountId: new mongoose.Types.ObjectId(accountId) } 
        : { userId: new mongoose.Types.ObjectId(userId) };

    const reversals = await Ledger.find({ ...reversalScope, direction: 'REVERSAL' }).select('_id parentTransactionId').lean();
    const excludedIds = new Set();
    for (const r of reversals) {
      excludedIds.add(r._id.toString());
      if (r.parentTransactionId) excludedIds.add(r.parentTransactionId.toString());
    }
    if (excludedIds.size > 0) {
      query._id = { $nin: [...excludedIds].map((id) => new mongoose.Types.ObjectId(id)) };
    }

    const parsedLimit = Math.min(parseInt(limit, 10) || 20, 100);

    const history = await Ledger.find(query)
      .populate('accountId', 'name')
      .sort({ transactedAt: -1, _id: -1 })
      .limit(parsedLimit)
      .lean();

    return res.status(200).json({
      success:    true,
      count:      history.length,
      nextCursor: history.length === parsedLimit ? history.at(-1)._id : null,
      data: history.map((tx) => ({
        ...tx,
        amount:      tx.amount.toString(),
        accountName: tx.accountId?.name || 'Unknown Account',
      })),
    });
  } catch (error) {
    next(error);
  }
};

// ─── 4. voidTransaction ───────────────────────────────────────────────────────

exports.voidTransaction = async (req, res, next) => {
  const userId = req.user.id;
  const { transactionId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(transactionId)) return errRes(res, 400, 'Invalid transactionId');

  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const ledger = await Ledger.findOne({ _id: transactionId, userId }).session(session);
      if (!ledger) {
        await session.abortTransaction();
        return errRes(res, 404, 'Transaction not found');
      }
      if (ledger.status !== 'COMPLETED') {
        await session.abortTransaction();
        return errRes(res, 400, `Only COMPLETED transactions can be voided. Current status: '${ledger.status}'`);
      }

      const account = await Account.findOne({ _id: ledger.accountId, userId }).session(session);
      if (!account) {
        await session.abortTransaction();
        return errRes(res, 404, 'Account not found');
      }

      const currentAvailable = new Decimal(account.availableBalance.toString());
      const currentReserved  = new Decimal(account.reservedBalance.toString());
      const { balanceChange, reservedChange } = computeReversalDelta(ledger.direction, ledger.transactionType, ledger.amount.toString());

      const newAvailable = currentAvailable.plus(balanceChange);
      const newReserved  = currentReserved.plus(reservedChange);

      if (newAvailable.isNegative()) {
        await session.abortTransaction();
        return errRes(res, 400, 'Voiding this transaction would result in a negative balance');
      }

      ledger.status = 'VOIDED';
      await ledger.save({ session });

      account.availableBalance = toDecimal128(newAvailable);
      account.reservedBalance  = toDecimal128(newReserved);
      await account.save({ session });

      // 🔥 UPDATE: Sync Goal Balance during Void
      if (ledger.goalId) {
        const goal = await Goal.findOne({ _id: ledger.goalId, userId }).session(session);
        if (goal) {
          const amt = parseFloat(ledger.amount.toString());
          if (ledger.direction === 'GOAL_ALLOCATION') {
             // Voiding a deposit -> reduce goal savings
            goal.currentAmount -= amt;
            if (goal.currentAmount < goal.targetAmount) goal.status = 'active';
          } else if (ledger.direction === 'GOAL_DEALLOCATION') {
            // Voiding a withdrawal -> increase goal savings
            goal.currentAmount += amt;
            if (goal.currentAmount >= goal.targetAmount) goal.status = 'completed';
          }
          await goal.save({ session });
        }
      }

      await session.commitTransaction();
      reconcileAfterTransaction(ledger.accountId.toString(), userId);

      return res.status(200).json({
        success:          true,
        txid:             ledger._id,
        status:           'VOIDED',
        availableBalance: newAvailable.toFixed(2),
        reservedBalance:  newReserved.toFixed(2),
      });

    } catch (error) {
      if (session.inTransaction()) await session.abortTransaction().catch(() => {});
      const isVersionError  = error.name === 'VersionError';
      const isWriteConflict = error.code === 112 || error.hasErrorLabel?.('TransientTransactionError');
      if ((isVersionError || isWriteConflict) && attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, Math.random() * 50 * attempt));
        continue;
      }
      return next(error);
    } finally {
      session.endSession();
    }
  }
};
// ─── 5. getLatestTransactions ──────────────────────────────────────────────────

exports.getLatestTransactions = async (req, res, next) => {
  try {
    const userId = req.user.id;

    // 1. Exclude reversed pairs so they don't clutter the recent list
    const reversals = await Ledger.find({ userId, direction: 'REVERSAL' })
      .select('_id parentTransactionId')
      .lean();

    const excludedIds = new Set();
    for (const r of reversals) {
      excludedIds.add(r._id.toString());
      if (r.parentTransactionId) excludedIds.add(r.parentTransactionId.toString());
    }

    const query = { 
      userId: new mongoose.Types.ObjectId(userId),
      status: 'COMPLETED' // Hide voided/pending items
    };

    if (excludedIds.size > 0) {
      query._id = { $nin: [...excludedIds].map((id) => new mongoose.Types.ObjectId(id)) };
    }

    // 2. Fetch latest 5 sorted by createdAt
    const latestTransactions = await Ledger.find(query)
      .populate('accountId', 'name')
      .sort({ createdAt: -1 }) // Sorts by newest first based on creation time
      .limit(5)
      .lean();

    return res.status(200).json({
      success: true,
      count: latestTransactions.length,
      data: latestTransactions.map((tx) => ({
        ...tx,
        amount: tx.amount.toString(),
        accountName: tx.accountId?.name || 'Unknown Account',
      })),
    });
  } catch (error) {
    console.error('[getLatestTransactions] Error:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch latest transactions' });
  }
};