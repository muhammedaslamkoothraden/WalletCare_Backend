'use strict';

const mongoose = require('mongoose');
const Decimal = require('decimal.js');
const Ledger = require('../models/Ledger');
const Account = require('../models/Account');
const Goal = require('../models/Goal');
const { assertString, StringValidationError } = require('../helpers/sanitize');
const {
  sanitizeCategory,
  sanitizeOptionalDescription,
  parseAmount,
} = require('../helpers/transactionInput');

const { initiateTransfer, TransferError } = require('../services/accountTransfer');
const { computeBalanceDelta, computeReversalDelta } = require('../services/ledgerDelta');
const { reconcileAccount } = require('../services/reconciliation');
const { createNotification } = require('../services/notification.service');

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
  'RESERVED_IN', 
  'RESERVED_OUT'
]));

const VALID_DIRECTION_TYPE_COMBINATIONS = Object.freeze(
  new Map([
    ['STANDARD', Object.freeze(new Set(['INCOME', 'EXPENSE']))],
    ['GOAL_ALLOCATION', Object.freeze(new Set(['EXPENSE', 'TRANSFER']))],
    ['GOAL_DEALLOCATION', Object.freeze(new Set(['INCOME', 'TRANSFER']))],
    ['GOAL_COMPLETION', Object.freeze(new Set(['EXPENSE']))],
    ['ACCOUNT_TRANSFER_OUT', Object.freeze(new Set(['TRANSFER']))],
    ['ACCOUNT_TRANSFER_IN', Object.freeze(new Set(['TRANSFER']))],
    ['REVERSAL', Object.freeze(new Set(['REVERSAL']))],
    ['RESERVED_IN', Object.freeze(new Set(['TRANSFER']))],
    ['RESERVED_OUT', Object.freeze(new Set(['TRANSFER']))],
  ])
);

const REQUIRED_FIELDS = Object.freeze([
  'accountId', 'amount', 'transactionType',
  'direction', 'category', 'idempotencyKey',
]);

const VALID_STATUSES = Object.freeze(new Set([
  'PENDING', 'COMPLETED', 'FAILED', 'VOIDED',
]));

const LOW_BALANCE_THRESHOLD = 500;
const LARGE_TX_THRESHOLD = 10000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function errRes(res, status, message) {
  // 🔥 FIX: Force the message to always be a plain string before sending it to Flutter
  let safeMessage = "An unknown error occurred";
  if (typeof message === 'string') {
    safeMessage = message;
  } else if (message && message.message) {
    safeMessage = message.message;
  } else if (message) {
    safeMessage = message.toString();
  }
  return res.status(status).json({ success: false, error: safeMessage });
}

const toDecimal128 = (value) => {
  if (value === null || value === undefined) {
    return mongoose.Types.Decimal128.fromString('0');
  }
  return mongoose.Types.Decimal128.fromString(value.toString());
};

function duplicateResponse(res, ledgerDoc, accountDoc) {
  return res.status(409).json({
    success: true,
    duplicate: true,
    txid: ledgerDoc._id,
    availableBalance: accountDoc?.availableBalance?.toString() ?? '0.00',
    reservedBalance: accountDoc?.reservedBalance?.toString() ?? '0.00',
  });
}

function reconcileAfterTransaction(accountId, userId) {
  reconcileAccount(accountId, userId, { autoCorrect: true })
    .then((result) => {
      if (result.status === 'OK') return;
      console.warn('[reconcileAfterTransaction] Mismatch detected', {
        accountId: result.accountId,
        status: result.status,
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
      accountId: req.body.accountId,
      amount: parseAmount(req.body.amount),
      transactionType: req.body.transactionType,
      direction: req.body.direction,
      category: sanitizeCategory(req.body.category),
      description: sanitizeOptionalDescription(req.body.description),
      idempotencyKey: assertString(req.body.idempotencyKey, 'idempotencyKey', { maxLength: 128 }),
      linkedAccountId: req.body.linkedAccountId,
      transactedAt: req.body.transactedAt,
      parentTransactionId: req.body.parentTransactionId ?? null,
    };

    if (input.idempotencyKey.length < 8) throw new StringValidationError('idempotencyKey must be at least 8 characters');
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

  // Pre-Transaction Validation
  if (!mongoose.Types.ObjectId.isValid(accountId)) return errRes(res, 400, 'Invalid accountId');
  if (linkedAccountId && !mongoose.Types.ObjectId.isValid(linkedAccountId)) return errRes(res, 400, 'Invalid linkedAccountId');
  if (parentTransactionId && !mongoose.Types.ObjectId.isValid(parentTransactionId)) return errRes(res, 400, 'Invalid parentTransactionId');
  if (!VALID_DIRECTIONS.has(direction)) return errRes(res, 400, `Invalid direction: ${direction}`);
  if (!VALID_TRANSACTION_TYPES.has(transactionType)) return errRes(res, 400, `Invalid transactionType: ${transactionType}`);

  const allowedTypes = VALID_DIRECTION_TYPE_COMBINATIONS.get(direction);
  if (!allowedTypes.has(transactionType)) return errRes(res, 400, `transactionType '${transactionType}' is not valid for direction '${direction}'.`);
  if (TRANSFER_DIRECTIONS.has(direction) && !linkedAccountId) return errRes(res, 400, `direction '${direction}' requires linkedAccountId`);
  if (linkedAccountId && accountId.toString() === linkedAccountId.toString()) return errRes(res, 400, 'accountId and linkedAccountId must not be the same account');
  if (direction === 'REVERSAL' && !parentTransactionId) return errRes(res, 400, 'parentTransactionId is required for REVERSAL');

  // 🔥 ANTIGRAVITY FIX: Pre-flight checks OUTSIDE the transaction lock to save 2+ seconds
  const [existingLedger, preFlightAccount] = await Promise.all([
    Ledger.findOne({ userId, idempotencyKey }).lean(),
    Account.findOne({ _id: accountId, userId }).lean()
  ]);

  if (existingLedger) return duplicateResponse(res, existingLedger, preFlightAccount);
  if (!preFlightAccount) return errRes(res, 404, 'Account not found');
  if (preFlightAccount.status === 'CLOSED' || preFlightAccount.status === 'FROZEN') {
    return errRes(res, 400, `Transactions are not permitted on a ${preFlightAccount.status.toLowerCase()} account`);
  }

  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const account = await Account.findOne({ _id: accountId, userId }).session(session);
      if (!account) {
        await session.abortTransaction();
        return errRes(res, 404, 'Account not found');
      }

      let parentTx = null;

      // ── 3. Reversal Validation & Multi-Leg Processing ──────────────────────
      if (direction === 'REVERSAL') {
        parentTx = await Ledger.findOne({ _id: parentTransactionId, userId }).session(session).lean();
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

        // 🎯 Handle Dual-Leg Transfer Reversals
        if (parentTx.transferGroupId) {
          const transferLegs = await Ledger.find({ transferGroupId: parentTx.transferGroupId, userId }).session(session).lean();
          
          const alreadyReversed = await Ledger.findOne({ 
            parentTransactionId: { $in: transferLegs.map(l => l._id) }, 
            direction: 'REVERSAL', userId 
          }).session(session).lean();
          
          if (alreadyReversed) {
            await session.abortTransaction();
            return errRes(res, 409, 'This transfer has already been reversed');
          }

          const reversedLedgers = [];
          for (const leg of transferLegs) {
            const legAccount = await Account.findOne({ _id: leg.accountId, userId }).session(session);
            const { balanceChange, reservedChange } = computeReversalDelta(leg.direction, leg.transactionType, leg.amount.toString());
            const newLegAvailable = new Decimal(legAccount.availableBalance.toString()).plus(balanceChange);
            const newLegReserved = new Decimal(legAccount.reservedBalance.toString()).plus(reservedChange);

            if (newLegAvailable.isNegative()) {
              await session.abortTransaction();
              return errRes(res, 400, `Reversing this causes a negative balance in account: ${legAccount.name}`);
            }

            reversedLedgers.push({
              userId, accountId: leg.accountId, amount: toDecimal128(leg.amount),
              transactionType: 'REVERSAL', direction: 'REVERSAL', category: 'Refund / Correction',
              description: `Reversal of Transfer: ${leg._id}`, idempotencyKey: `${idempotencyKey}-${leg.direction}`, 
              linkedAccountId: leg.linkedAccountId, parentTransactionId: leg._id, status: 'COMPLETED',
              transferGroupId: leg.transferGroupId, transactedAt: transactedAt ? new Date(transactedAt) : new Date(),
              runningBalance: toDecimal128(newLegAvailable)
            });

            legAccount.availableBalance = toDecimal128(newLegAvailable);
            legAccount.reservedBalance = toDecimal128(newLegReserved);
            await legAccount.save({ session });
          }

          await Ledger.insertMany(reversedLedgers, { session });
          await session.commitTransaction();

          for (const leg of transferLegs) reconcileAfterTransaction(leg.accountId.toString(), userId);

          return res.status(201).json({
            success: true, message: "Transfer fully reversed", reversedCount: reversedLedgers.length
          });
        } 
        
        // --- Standard Single-Leg Reversal Fallback ---
        const alreadyReversed = await Ledger.findOne({ parentTransactionId, direction: 'REVERSAL', userId }).session(session).lean();
        if (alreadyReversed) {
          await session.abortTransaction();
          return errRes(res, 409, 'This transaction has already been reversed');
        }
      }

      // 4. Calculate Balance Delta
      const currentAvailable = new Decimal(account.availableBalance.toString());
      let balanceChange;

      if (direction === 'REVERSAL') {
        ({ balanceChange } = computeReversalDelta(parentTx.direction, parentTx.transactionType, safeAmount));
      } else {
        ({ balanceChange } = computeBalanceDelta(direction, transactionType, safeAmount));
      }

      const newAvailable = currentAvailable.plus(balanceChange);

      if (newAvailable.isNegative()) {
        await session.abortTransaction();
        return errRes(res, 400, 'Insufficient available balance');
      }

      // 5. Save Ledger
      const [newLedger] = await Ledger.create([{
        userId, accountId, amount: toDecimal128(safeAmount), transactionType, direction,
        category: safeCategory, description: safeDescription, idempotencyKey,
        linkedAccountId: linkedAccountId || null, parentTransactionId: parentTransactionId || null,
        status: 'COMPLETED', transactedAt: transactedAt ? new Date(transactedAt) : new Date(),
        runningBalance: toDecimal128(newAvailable),
      }], { session });

      // 6. Save Account Balance
      account.availableBalance = toDecimal128(newAvailable);
      await account.save({ session });

      // --- 7. GOAL SYNCHRONIZATION BLOCK ---
      if (direction === 'REVERSAL' && parentTx && parentTx.goalId) {
        const goal = await Goal.findOne({ _id: parentTx.goalId, userId }).session(session);
        if (goal) {
          const currentAmt = new Decimal(goal.currentAmount.toString());
          const reversalAmt = new Decimal(safeAmount.toString());
          const targetAmt = new Decimal(goal.targetAmount.toString());

          if (parentTx.direction === 'GOAL_ALLOCATION') {
            const newAmt = currentAmt.minus(reversalAmt);
            goal.currentAmount = newAmt.toNumber();
            if (newAmt.lessThan(targetAmt)) goal.status = 'active';
          } else if (parentTx.direction === 'GOAL_DEALLOCATION') {
            const newAmt = currentAmt.plus(reversalAmt);
            goal.currentAmount = newAmt.toNumber();
            if (newAmt.greaterThanOrEqualTo(targetAmt)) goal.status = 'completed';
          }
          await goal.save({ session });
        }
      }

      // 8. Commit & Reconcile
      await session.commitTransaction();
      reconcileAfterTransaction(accountId, userId);

      // 9. 🔥 ANTIGRAVITY FIX: Fire-and-forget Notifications (No await blocks UI)
      const isExpense = transactionType === 'EXPENSE';
      const isTransfer = TRANSFER_DIRECTIONS.has(direction);
      const amountDecimal = new Decimal(safeAmount.toString());
      const minBalance = new Decimal(account.minBalance?.toString() || '0');
      const accountName = account.name || 'Account';

      if (isExpense && minBalance.greaterThan(0) && newAvailable.lessThan(minBalance)) {
        createNotification(userId, `Balance Alert: Your '${accountName}' account is below minimum. Current: ₹${newAvailable.toFixed(2)}.`, 'low_balance')
          .catch(e => console.warn('Low balance notification failed:', e.message));
      } else if (amountDecimal.greaterThanOrEqualTo(LARGE_TX_THRESHOLD)) {
        const actionWord = isTransfer ? 'transferred' : isExpense ? 'debited' : 'credited';
        createNotification(userId, `Transaction Alert: ₹${amountDecimal.toFixed(2)} was ${actionWord} on '${accountName}'.`, 'large_transaction')
          .catch(e => console.warn('Large transaction notification failed:', e.message));
      }

      // 10. Respond
      return res.status(201).json({ success: true, txid: newLedger._id, availableBalance: newAvailable.toFixed(2) });

    } catch (error) {
      if (session.inTransaction()) await session.abortTransaction().catch(() => { });
      const isVersionError = error.name === 'VersionError';
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

exports.accountTransfer = async (req, res, next) => {
  const userId = req.user.id;
  let input;
  try {
    const missing = ['fromAccountId', 'toAccountId', 'amount', 'category', 'idempotencyKey'].find((f) => !req.body[f]);
    if (missing) throw new Error(`${missing} is required`);

    input = {
      fromAccountId: req.body.fromAccountId, toAccountId: req.body.toAccountId,
      amount: parseAmount(req.body.amount), category: sanitizeCategory(req.body.category),
      description: sanitizeOptionalDescription(req.body.description),
      idempotencyKey: assertString(req.body.idempotencyKey, 'idempotencyKey', { maxLength: 128 }),
      transactedAt: req.body.transactedAt,
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
    reconcileAfterTransaction(toAccountId, userId);

    return res.status(201).json({ success: true, ...result });
  } catch (error) {
    if (error instanceof TransferError) return errRes(res, error.statusCode, error.message);
    next(error);
  }
};

// ─── 3. getHistory ────────────────────────────────────────────────────────────

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
      success: true,
      count: history.length,
      nextCursor: history.length === parsedLimit ? history.at(-1)._id : null,
      data: history.map((tx) => ({
        ...tx,
        // 1. Flatten IDs and Names
        accountId: tx.accountId?._id ? tx.accountId._id.toString() : tx.accountId?.toString(), 
        accountName: tx.accountId?.name || 'Unknown Account',
        
        // 2. Convert ALL Decimals to Strings (Crucial for Flutter)
        amount: tx.amount ? tx.amount.toString() : "0.00",
        runningBalance: tx.runningBalance ? tx.runningBalance.toString() : "0.00",
        
        // 3. Handle linkedAccountId if it exists
        linkedAccountId: tx.linkedAccountId ? tx.linkedAccountId.toString() : null,
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
      const currentReserved = new Decimal(account.reservedBalance.toString());
      const { balanceChange, reservedChange } = computeReversalDelta(ledger.direction, ledger.transactionType, ledger.amount.toString());

      const newAvailable = currentAvailable.plus(balanceChange);
      const newReserved = currentReserved.plus(reservedChange);

      if (newAvailable.isNegative()) {
        await session.abortTransaction();
        return errRes(res, 400, 'Voiding this transaction would result in a negative balance');
      }

      ledger.status = 'VOIDED';
      await ledger.save({ session });

      account.availableBalance = toDecimal128(newAvailable);
      account.reservedBalance = toDecimal128(newReserved);
      await account.save({ session });

      if (ledger.goalId) {
        const goal = await Goal.findOne({ _id: ledger.goalId, userId }).session(session);
        if (goal) {
          const amt = parseFloat(ledger.amount.toString());
          if (ledger.direction === 'GOAL_ALLOCATION') {
            goal.currentAmount -= amt;
            if (goal.currentAmount < goal.targetAmount) goal.status = 'active';
          } else if (ledger.direction === 'GOAL_DEALLOCATION') {
            goal.currentAmount += amt;
            if (goal.currentAmount >= goal.targetAmount) goal.status = 'completed';
          }
          await goal.save({ session });
        }
      }

      await session.commitTransaction();
      reconcileAfterTransaction(ledger.accountId.toString(), userId);

      return res.status(200).json({
        success: true,
        txid: ledger._id,
        status: 'VOIDED',
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
      status: 'COMPLETED',
    };

    if (excludedIds.size > 0) {
      query._id = { $nin: [...excludedIds].map((id) => new mongoose.Types.ObjectId(id)) };
    }

    const latestTransactions = await Ledger.find(query)
      .populate('accountId', 'name')
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

   return res.status(200).json({
      success: true,
      count: history.length,
      nextCursor: history.length === parsedLimit ? history.at(-1)._id : null,
      data: history.map((tx) => ({
        ...tx,
        // 1. Flatten IDs and Names
        accountId: tx.accountId?._id ? tx.accountId._id.toString() : tx.accountId?.toString(), 
        accountName: tx.accountId?.name || 'Unknown Account',
        
        // 2. Convert ALL Decimals to Strings (Crucial for Flutter)
        amount: tx.amount ? tx.amount.toString() : "0.00",
        runningBalance: tx.runningBalance ? tx.runningBalance.toString() : "0.00",
        
        // 3. Handle linkedAccountId if it exists
        linkedAccountId: tx.linkedAccountId ? tx.linkedAccountId.toString() : null,
      })),
    });
  } catch (error) {
    console.error('[getLatestTransactions] Error:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch latest transactions' });
  }
}

// ─── 6. reserveFunds ───────────────────────────────────────────────────────────

exports.reserveFunds = async (req, res, next) => {
  const userId = req.user.id;
  let input;

  try {
    const missing = ['accountId', 'amount', 'action', 'idempotencyKey'].find((f) => !req.body[f]);
    if (missing) throw new Error(`${missing} is required`);

    input = {
      accountId: req.body.accountId,
      amount: parseAmount(req.body.amount), 
      action: req.body.action.toUpperCase(),
      category: sanitizeCategory(req.body.category || 'System Reserve'),
      description: sanitizeOptionalDescription(req.body.description),
      idempotencyKey: assertString(req.body.idempotencyKey, 'idempotencyKey', { maxLength: 128 }),
    };

    if (input.idempotencyKey.length < 8) throw new StringValidationError('idempotencyKey must be at least 8 characters');
    if (!['RESERVE', 'RELEASE'].includes(input.action)) throw new Error("action must be exactly 'RESERVE' or 'RELEASE'");
  } catch (error) {
    return errRes(res, 400, error.message);
  }

  const { accountId, amount: safeAmount, action, category: safeCategory, description: safeDescription, idempotencyKey } = input;

  if (!mongoose.Types.ObjectId.isValid(accountId)) return errRes(res, 400, 'Invalid accountId');

  // 🔥 ANTIGRAVITY FIX: Pre-flight checks OUTSIDE the transaction lock to save 2+ seconds
  const [existingLedger, preFlightAccount] = await Promise.all([
    Ledger.findOne({ userId, idempotencyKey }).lean(),
    Account.findOne({ _id: accountId, userId }).lean()
  ]);

  if (existingLedger) return duplicateResponse(res, existingLedger, preFlightAccount);
  if (!preFlightAccount) return errRes(res, 404, 'Account not found');
  if (preFlightAccount.status === 'CLOSED' || preFlightAccount.status === 'FROZEN') {
    return errRes(res, 400, `Cannot modify reserves on a ${preFlightAccount.status.toLowerCase()} account`);
  }

  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const account = await Account.findOne({ _id: accountId, userId }).session(session);
      
      const currentAvailable = new Decimal(account.availableBalance.toString());
      const currentReserved = new Decimal(account.reservedBalance.toString());
      const moveAmount = new Decimal(safeAmount.toString());

      let newAvailable, newReserved, direction;

      if (action === 'RESERVE') {
        direction = 'RESERVED_IN'; 
        newAvailable = currentAvailable.minus(moveAmount);
        newReserved = currentReserved.plus(moveAmount);
        if (newAvailable.isNegative()) {
          await session.abortTransaction();
          return errRes(res, 400, `Insufficient available balance to reserve ₹${moveAmount.toFixed(2)}`);
        }
      } else {
        direction = 'RESERVED_OUT'; 
        newAvailable = currentAvailable.plus(moveAmount);
        newReserved = currentReserved.minus(moveAmount);
        if (newReserved.isNegative()) {
          await session.abortTransaction();
          return errRes(res, 400, `Insufficient reserved balance to release ₹${moveAmount.toFixed(2)}`);
        }
      }

      const [newLedger] = await Ledger.create([{
        userId, accountId, amount: toDecimal128(safeAmount), transactionType: 'TRANSFER', direction,
        category: safeCategory, description: safeDescription, idempotencyKey, status: 'COMPLETED',
        transactedAt: new Date(), runningBalance: toDecimal128(newAvailable),
      }], { session });

      account.availableBalance = toDecimal128(newAvailable);
      account.reservedBalance = toDecimal128(newReserved);
      await account.save({ session });

      await session.commitTransaction();
      reconcileAfterTransaction(accountId, userId);

      return res.status(201).json({
        success: true, action, txid: newLedger._id,
        availableBalance: newAvailable.toFixed(2), reservedBalance: newReserved.toFixed(2),
      });

    } catch (error) {
      if (session.inTransaction()) await session.abortTransaction().catch(() => {});
      const isVersionError = error.name === 'VersionError';
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