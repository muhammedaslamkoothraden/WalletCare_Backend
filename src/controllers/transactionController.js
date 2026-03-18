'use strict';

const mongoose = require('mongoose');
const Decimal  = require('decimal.js');
const Ledger   = require('../models/Ledger');
const Account  = require('../models/Account');

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

// Every permitted direction → transactionType combination.
// Frozen at both levels — outer Map and every inner Set —
// so nothing can mutate validation logic at runtime.
const VALID_DIRECTION_TYPE_COMBINATIONS = Object.freeze(
  new Map([
    ['STANDARD',             Object.freeze(new Set(['INCOME', 'EXPENSE']))],
    ['GOAL_ALLOCATION',      Object.freeze(new Set(['EXPENSE']))],
    ['GOAL_DEALLOCATION',    Object.freeze(new Set(['INCOME']))],
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Single error shape across all failure paths so the frontend
// always receives { success: false, error: '...' } on failure
function errRes(res, status, message) {
  return res.status(status).json({ success: false, error: message });
}

// ─── processTransaction ───────────────────────────────────────────────────────

exports.processTransaction = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const userId = req.user.id;
    const {
      accountId, amount, transactionType,
      direction, category, description,
      idempotencyKey, parentTransactionId,
      linkedAccountId,
    } = req.body;

    // ── Required field validation ─────────────────────────────────────────────

    const missingField = REQUIRED_FIELDS.find((f) => !req.body[f]);
    if (missingField) {
      await session.abortTransaction();
      return errRes(res, 400, `${missingField} is required`);
    }

    // ── Enum validation ───────────────────────────────────────────────────────

    // direction checked before combination — if direction is unknown,
    // .get() returns undefined and the combination check would throw
    // instead of returning a clean 400
    if (!VALID_DIRECTIONS.has(direction)) {
      await session.abortTransaction();
      return errRes(res, 400, `Invalid direction: ${direction}`);
    }

    if (!VALID_TRANSACTION_TYPES.has(transactionType)) {
      await session.abortTransaction();
      return errRes(res, 400, `Invalid transactionType: ${transactionType}`);
    }

    // Both values are individually valid above but their combination
    // may still be logically inconsistent — e.g. INCOME + GOAL_ALLOCATION
    // would corrupt balance semantics and reporting categorisation
    const allowedTypes = VALID_DIRECTION_TYPE_COMBINATIONS.get(direction);
    if (!allowedTypes.has(transactionType)) {
      await session.abortTransaction();
      return errRes(res, 400,
        `transactionType '${transactionType}' is not valid for direction '${direction}'. ` +
        `Allowed: ${[...allowedTypes].join(', ')}`
      );
    }

    // ── Amount validation ─────────────────────────────────────────────────────

    let safeAmount;
    try {
      safeAmount = new Decimal(amount.toString());
      if (safeAmount.lessThanOrEqualTo(0)) throw new Error();
    } catch {
      await session.abortTransaction();
      return errRes(res, 400, 'Amount must be a valid number greater than 0');
    }

    // ── Transfer validation ───────────────────────────────────────────────────

    if (TRANSFER_DIRECTIONS.has(direction) && !linkedAccountId) {
      await session.abortTransaction();
      return errRes(res, 400, `direction '${direction}' requires linkedAccountId`);
    }

    if (linkedAccountId && accountId.toString() === linkedAccountId.toString()) {
      await session.abortTransaction();
      return errRes(res, 400, 'accountId and linkedAccountId must not be the same account');
    }

    // ── Idempotency check ─────────────────────────────────────────────────────
    // Returns the same shape as a first-time success so the client
    // retry handler needs no special-case logic
    const existingLedger = await Ledger
      .findOne({ userId, idempotencyKey })
      .session(session)
      .lean();

    if (existingLedger) {
      await session.abortTransaction();
      return res.status(409).json({
        success:          true,
        duplicate:        true,
        txid:             existingLedger._id,
        availableBalance: existingLedger.snapshotAvailable?.toString() ?? '0.00',
        reservedBalance:  existingLedger.snapshotReserved?.toString()  ?? '0.00',
      });
    }

    // ── Account validation ────────────────────────────────────────────────────

    const account = await Account
      .findOne({ _id: accountId, userId })
      .session(session);

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

    // ── Reversal validation ───────────────────────────────────────────────────

    if (direction === 'REVERSAL') {
      if (!parentTransactionId) {
        await session.abortTransaction();
        return errRes(res, 400, 'parentTransactionId is required for REVERSAL');
      }

      const parentTx = await Ledger
        .findOne({ _id: parentTransactionId, userId })
        .session(session)
        .lean();

      if (!parentTx) {
        await session.abortTransaction();
        return errRes(res, 404, 'Parent transaction not found');
      }

      if (parentTx.status !== 'COMPLETED') {
        await session.abortTransaction();
        return errRes(res, 400,
          `Cannot reverse a transaction with status '${parentTx.status}'`
        );
      }

      // Partial reversals leave the ledger in an irreconcilable state —
      // reversal amount must exactly match the original
      const parentAmount = new Decimal(parentTx.amount.toString());
      if (!safeAmount.equals(parentAmount)) {
        await session.abortTransaction();
        return errRes(res, 400,
          `Reversal amount (${safeAmount.toFixed(2)}) must match ` +
          `original transaction amount (${parentAmount.toFixed(2)})`
        );
      }

      const alreadyReversed = await Ledger
        .findOne({ parentTransactionId, direction: 'REVERSAL', userId })
        .session(session)
        .lean();

      if (alreadyReversed) {
        await session.abortTransaction();
        return errRes(res, 409, 'This transaction has already been reversed');
      }
    }

    // ── Balance calculation ───────────────────────────────────────────────────

    const currentAvailable = new Decimal(account.availableBalance.toString());
    const currentReserved  = new Decimal(account.reservedBalance.toString());

    let balanceChange  = new Decimal(0);
    let reservedChange = new Decimal(0);

    switch (direction) {
      case 'STANDARD':
        if (transactionType === 'INCOME')  balanceChange = safeAmount;
        if (transactionType === 'EXPENSE') balanceChange = safeAmount.negated();
        break;
      case 'GOAL_ALLOCATION':
        balanceChange  = safeAmount.negated();
        reservedChange = safeAmount;
        break;
      case 'GOAL_DEALLOCATION':
        balanceChange  = safeAmount;
        reservedChange = safeAmount.negated();
        break;
      case 'GOAL_COMPLETION':
        reservedChange = safeAmount.negated();
        break;
      case 'ACCOUNT_TRANSFER_OUT':
        balanceChange = safeAmount.negated();
        break;
      case 'ACCOUNT_TRANSFER_IN':
        balanceChange = safeAmount;
        break;
      case 'REVERSAL':
        balanceChange = safeAmount;
        break;
    }

    const newAvailable = currentAvailable.plus(balanceChange);
    const newReserved  = currentReserved.plus(reservedChange);

    if (newAvailable.isNegative()) {
      await session.abortTransaction();
      return errRes(res, 400, 'FUNDS_INSUFFICIENT');
    }

    if (newReserved.isNegative()) {
      await session.abortTransaction();
      return errRes(res, 400, 'Insufficient reserved balance');
    }

    // ── Persist ───────────────────────────────────────────────────────────────

    const [newLedger] = await Ledger.create(
      [{
        userId,
        accountId,
        amount:              mongoose.Types.Decimal128.fromString(safeAmount.toFixed(2)),
        transactionType,
        direction,
        category,
        description,
        idempotencyKey,
        linkedAccountId:     linkedAccountId     || null,
        parentTransactionId: parentTransactionId || null,
        status:              'COMPLETED',
      }],
      { session }
    );

    account.availableBalance = mongoose.Types.Decimal128.fromString(newAvailable.toFixed(2));
    account.reservedBalance  = mongoose.Types.Decimal128.fromString(newReserved.toFixed(2));
    await account.save({ session });

    await session.commitTransaction();

    return res.status(201).json({
      success:          true,
      txid:             newLedger._id,
      availableBalance: account.availableBalance.toString(),
      reservedBalance:  account.reservedBalance.toString(),
    });

  } catch (error) {
    if (session.inTransaction()) {
      try { await session.abortTransaction(); } catch (_) {}
    }

    // Race condition: two identical requests passed the findOne check
    // simultaneously — unique index on { userId, idempotencyKey } rejects
    // the second write. Mirror the pre-check 409 shape.
    if (error.code === 11000) {
      return res.status(409).json({
        success:   true,
        duplicate: true,
        error:     'Conflict: Duplicate key',
      });
    }

    next(error);
  } finally {
    session.endSession();
  }
};

// ─── getHistory ───────────────────────────────────────────────────────────────

exports.getHistory = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { accountId, category, limit = 20, lastId } = req.query;

    // 1. Build Query Object
    const query = { userId };

    if (accountId) {
      if (!mongoose.Types.ObjectId.isValid(accountId)) {
        return errRes(res, 400, 'Invalid accountId');
      }
      query.accountId = new mongoose.Types.ObjectId(accountId);
    }

    if (category) {
      if (typeof category !== 'string' || category.trim().length === 0) {
        return errRes(res, 400, 'Invalid category filter');
      }
      query.category = category.trim();
    }

    // Keyset pagination: client passes _id of the last received item as lastId.
    // Faster than skip() at scale — jumps directly using the { userId, _id: -1 } index
    if (lastId) {
      if (!mongoose.Types.ObjectId.isValid(lastId)) {
        return errRes(res, 400, 'Invalid lastId cursor');
      }
      query._id = { $lt: new mongoose.Types.ObjectId(lastId) };
    }

    const parsedLimit = Math.min(parseInt(limit, 10) || 20, 100);

    const history = await Ledger.find(query)
      .populate('accountId', 'name')
      .sort({ _id: -1 })
      .limit(parsedLimit)
      .lean();

    return res.status(200).json({
      success:    true,
      count:      history.length,
      nextCursor: history.length === parsedLimit ? history.at(-1)._id : null,
      data:       history.map((tx) => ({
        ...tx,
        amount:      tx.amount.toString(),
        accountName: tx.accountId?.name || 'Unknown Account',
      })),
    });
  } catch (error) {
    next(error);
  }
};