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

// Directions that involve a counterparty account and create dual ledger legs.
const TRANSFER_DIRECTIONS = Object.freeze(new Set([
  'ACCOUNT_TRANSFER_IN',
  'ACCOUNT_TRANSFER_OUT',
]));

// All permitted transactionType values. RESERVE is used exclusively by
// RESERVED_IN and RESERVED_OUT directions.
const VALID_TRANSACTION_TYPES = Object.freeze(new Set([
  'INCOME', 'EXPENSE', 'TRANSFER', 'REVERSAL', 'RESERVE',
]));

// All permitted direction values. Must stay in sync with the Ledger schema enum.
const VALID_DIRECTIONS = Object.freeze(new Set([
  'STANDARD',
  'GOAL_ALLOCATION',
  'GOAL_DEALLOCATION',
  'GOAL_COMPLETION',
  'ACCOUNT_TRANSFER_IN',
  'ACCOUNT_TRANSFER_OUT',
  'REVERSAL',
  'RESERVED_IN',
  'RESERVED_OUT',
]));

// Enforces the direction → transactionType contract defined in the Ledger schema.
// Any combination not listed here is rejected before the transaction lock is acquired.
const VALID_DIRECTION_TYPE_COMBINATIONS = Object.freeze(
  new Map([
    ['STANDARD',             Object.freeze(new Set(['INCOME', 'EXPENSE']))],
    ['GOAL_ALLOCATION',      Object.freeze(new Set(['EXPENSE', 'TRANSFER']))],
    ['GOAL_DEALLOCATION',    Object.freeze(new Set(['INCOME', 'TRANSFER']))],
    ['GOAL_COMPLETION',      Object.freeze(new Set(['EXPENSE']))],
    ['ACCOUNT_TRANSFER_OUT', Object.freeze(new Set(['TRANSFER']))],
    ['ACCOUNT_TRANSFER_IN',  Object.freeze(new Set(['TRANSFER']))],
    ['REVERSAL',             Object.freeze(new Set(['REVERSAL']))],
    ['RESERVED_IN',          Object.freeze(new Set(['RESERVE']))],
    ['RESERVED_OUT',         Object.freeze(new Set(['RESERVE']))],
  ])
);

// Fields required on every processTransaction request body.
const REQUIRED_FIELDS = Object.freeze([
  'accountId', 'amount', 'transactionType',
  'direction', 'category', 'idempotencyKey',
]);

const VALID_STATUSES = Object.freeze(new Set([
  'PENDING', 'COMPLETED', 'FAILED', 'VOIDED',
]));

// Notification thresholds — centralised so product can tune without touching logic.
const LOW_BALANCE_THRESHOLD = 500;
const LARGE_TX_THRESHOLD    = 10000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Normalises any error type to a plain string before sending to the client.
// Prevents raw Error objects or objects with circular refs from reaching Flutter.
function errRes(res, status, message) {
  let safeMessage = 'An unknown error occurred';
  if (typeof message === 'string')   safeMessage = message;
  else if (message?.message)         safeMessage = message.message;
  else if (message)                  safeMessage = message.toString();
  return res.status(status).json({ success: false, error: safeMessage });
}

// Wraps any numeric value in a MongoDB Decimal128 for safe persistence.
// Always call .toString() before passing back into Decimal arithmetic.
const toDecimal128 = (value) => {
  if (value === null || value === undefined) {
    return mongoose.Types.Decimal128.fromString('0');
  }
  return mongoose.Types.Decimal128.fromString(value.toString());
};

// Returns a 409 with the original ledger entry when an idempotent replay
// is detected. Clients can treat this as a successful no-op.
function duplicateResponse(res, ledgerDoc, accountDoc) {
  return res.status(409).json({
    success:          true,
    duplicate:        true,
    txid:             ledgerDoc._id,
    availableBalance: accountDoc?.availableBalance?.toString() ?? '0.00',
    reservedBalance:  accountDoc?.reservedBalance?.toString()  ?? '0.00',
  });
}

// Fires reconciliation asynchronously after commit so it never blocks the
// HTTP response. Logs mismatches for ops visibility but does not throw.
function reconcileAfterTransaction(accountId, userId) {
  reconcileAccount(accountId, userId, { autoCorrect: true })
    .then((result) => {
      if (result.status === 'OK') return;
      console.warn('[reconcile] Mismatch detected', {
        accountId: result.accountId,
        status:    result.status,
      });
    })
    .catch((err) => {
      console.error('[reconcile] Unexpected error', {
        accountId,
        userId,
        error: err.message,
      });
    });
}

// Serialises a raw Ledger document into the shape consumed by Flutter clients.
// Centralised here so all endpoints return a consistent response envelope.
function formatLedgerEntry(tx) {
  return {
    _id:                   tx._id.toString(),
    userId:                tx.userId.toString(),
    accountId:             tx.accountId?._id ? tx.accountId._id.toString() : tx.accountId?.toString(),
    accountName:           tx.accountId?.name ?? 'Unknown Account',
    amount:                tx.amount?.toString()         ?? '0.00',
    runningBalance:        tx.runningBalance?.toString() ?? '0.00',
    transactionType:       tx.transactionType,
    direction:             tx.direction,
    category:              tx.category,
    description:           tx.description             ?? null,
    status:                tx.status,
    idempotencyKey:        tx.idempotencyKey,
    linkedAccountId:       tx.linkedAccountId?.toString()       ?? null,
    parentTransactionId:   tx.parentTransactionId?.toString()   ?? null,
    goalId:                tx.goalId?.toString()                ?? null,
    transferGroupId:       tx.transferGroupId?.toString()       ?? null,
    transactedAt:          tx.transactedAt,
    createdAt:             tx.createdAt,
  };
}

// ─── 1. processTransaction ────────────────────────────────────────────────────
//
// Core ledger write path. Handles all single-leg movements (STANDARD, GOAL_*,
// RESERVED_*) and single-leg REVERSAL entries. Dual-leg account transfers are
// delegated to accountTransfer → initiateTransfer.
//
// Retry loop guards against optimistic concurrency (VersionError) and
// transient MongoDB write conflicts (error code 112).

exports.processTransaction = async (req, res, next) => {
  const userId = req.user.id;
  let input;

  try {
    const missingField = REQUIRED_FIELDS.find((f) => !req.body[f]);
    if (missingField) throw new Error(`${missingField} is required`);

    input = {
      accountId:            req.body.accountId,
      amount:               parseAmount(req.body.amount),
      transactionType:      req.body.transactionType,
      direction:            req.body.direction,
      category:             sanitizeCategory(req.body.category),
      description:          sanitizeOptionalDescription(req.body.description),
      idempotencyKey:       assertString(req.body.idempotencyKey, 'idempotencyKey', { maxLength: 128 }),
      linkedAccountId:      req.body.linkedAccountId,
      transactedAt:         req.body.transactedAt,
      parentTransactionId:  req.body.parentTransactionId ?? null,
    };

    if (input.idempotencyKey.length < 8) {
      throw new StringValidationError('idempotencyKey must be at least 8 characters');
    }
    if (input.transactedAt != null && isNaN(new Date(input.transactedAt).getTime())) {
      throw new Error('transactedAt must be a valid date');
    }
  } catch (error) {
    return errRes(res, 400, error.message);
  }

  const {
    accountId, amount: safeAmount, transactionType, direction,
    category: safeCategory, description: safeDescription,
    idempotencyKey, linkedAccountId, transactedAt, parentTransactionId,
  } = input;

  // ── Input validation — performed once, outside the retry loop ─────────────
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
  if (!allowedTypes.has(transactionType))
    return errRes(res, 400, `transactionType '${transactionType}' is not valid for direction '${direction}'`);
  if (TRANSFER_DIRECTIONS.has(direction) && !linkedAccountId)
    return errRes(res, 400, `direction '${direction}' requires linkedAccountId`);
  if (linkedAccountId && accountId.toString() === linkedAccountId.toString())
    return errRes(res, 400, 'accountId and linkedAccountId must not be the same account');
  if (direction === 'REVERSAL' && !parentTransactionId)
    return errRes(res, 400, 'parentTransactionId is required for REVERSAL');

  // ── Pre-flight reads — outside the transaction lock to minimise lock duration ──
  const [existingLedger, preFlightAccount] = await Promise.all([
    Ledger.findOne({ userId, idempotencyKey }).lean(),
    Account.findOne({ _id: accountId, userId }).lean(),
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

      // ── Reversal validation & dual-leg transfer handling ───────────────────
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

        // Guard: one reversal per parent — controller check provides a clear error
        // message; the one_reversal_per_parent DB index is the true enforcement layer.
        const existingReversal = await Ledger.findOne({
          userId,
          direction: 'REVERSAL',
          parentTransactionId: parentTx._id,
        }).session(session).lean();

        if (existingReversal) {
          await session.abortTransaction();
          return errRes(res, 400, 'This transaction has already been reversed');
        }

        // Guard: only the latest transaction on this account can be reversed
        const latestTx = await Ledger.findOne({
          accountId: parentTx.accountId,
          userId,
          direction: { $ne: 'REVERSAL' },
          status:    'COMPLETED',
        })
          .sort({ createdAt: -1, _id: -1 })
          .session(session)
          .lean();

        if (!latestTx || latestTx._id.toString() !== parentTransactionId.toString()) {
          await session.abortTransaction();
          return errRes(res, 400, 'Only the most recent transaction can be reversed');
        }

        // Dual-leg path: if the parent belongs to a transfer group, reverse all legs
        // atomically so both accounts are restored in a single transaction.
        if (parentTx.transferGroupId) {
          const transferLegs = await Ledger.find({
            transferGroupId: parentTx.transferGroupId,
            userId,
          }).session(session).lean();

          const reversedLedgers = [];

          for (const leg of transferLegs) {
            // For legs other than the one the caller referenced, verify that no
            // newer unrelated transaction has been posted to the counterparty account.
            if (leg._id.toString() !== parentTransactionId.toString()) {
              const latestLegTx = await Ledger.findOne({
                accountId: leg.accountId,
                userId,
                direction: { $ne: 'REVERSAL' },
                status:    'COMPLETED',
              })
              .sort({ createdAt: -1, _id: -1 })
              .session(session)
              .lean();

              if (latestLegTx && latestLegTx._id.toString() !== leg._id.toString()) {
                await session.abortTransaction();
                return errRes(res, 400, 'Cannot reverse transfer: a newer transaction exists on the linked account');
              }
            }

            const legAccount = await Account.findOne({
              _id: leg.accountId,
              userId,
            }).session(session);

            if (!legAccount) {
              await session.abortTransaction();
              return errRes(res, 404, `Account not found for transfer leg: ${leg.accountId}`);
            }

            const { balanceChange, reservedChange } = computeReversalDelta(
              leg.direction,
              leg.transactionType,
              leg.amount.toString()
            );

            const newLegAvailable = new Decimal(legAccount.availableBalance.toString()).plus(balanceChange);
            const newLegReserved  = new Decimal(legAccount.reservedBalance.toString()).plus(reservedChange);

            if (newLegAvailable.isNegative()) {
              await session.abortTransaction();
              return errRes(res, 400, `Reversing this transfer would cause a negative balance on account: ${legAccount.name}`);
            }

            reversedLedgers.push({
              userId,
              accountId:            leg.accountId,
              amount:               toDecimal128(leg.amount),
              transactionType:      'REVERSAL',
              direction:            'REVERSAL',
              category:             'Refund / Correction',
              description:          `Reversal of transfer leg: ${leg._id}`,
              idempotencyKey:       `${idempotencyKey}-${leg.direction}`,
              linkedAccountId:      leg.linkedAccountId,
              parentTransactionId:  leg._id,
              status:               'COMPLETED',
              transferGroupId:      leg.transferGroupId,
              transactedAt:         transactedAt ? new Date(transactedAt) : new Date(),
              runningBalance:       toDecimal128(newLegAvailable),
            });

            legAccount.availableBalance = toDecimal128(newLegAvailable);
            legAccount.reservedBalance  = toDecimal128(newLegReserved);
            await legAccount.save({ session });
          }

          await Ledger.insertMany(reversedLedgers, { session });
          await session.commitTransaction();

          for (const leg of transferLegs) {
            reconcileAfterTransaction(leg.accountId.toString(), userId);
          }

          return res.status(201).json({
            success:       true,
            message:       'Transfer fully reversed',
            reversedCount: reversedLedgers.length,
          });
        }

        // Single-leg reversal — falls through to the balance delta step below.
      }

      // ── Balance delta computation ───────────────────────────────────────────
      const currentAvailable = new Decimal(account.availableBalance.toString());

      const { balanceChange } = direction === 'REVERSAL'
        ? computeReversalDelta(parentTx.direction, parentTx.transactionType, safeAmount)
        : computeBalanceDelta(direction, transactionType, safeAmount);

      const newAvailable = currentAvailable.plus(balanceChange);

      if (newAvailable.isNegative()) {
        await session.abortTransaction();
        return errRes(res, 400, 'Insufficient available balance');
      }

      // ── Ledger write ───────────────────────────────────────────────────────
      const [newLedger] = await Ledger.create([{
        userId,
        accountId,
        amount:               toDecimal128(safeAmount),
        transactionType,
        direction,
        category:             safeCategory,
        description:          safeDescription,
        idempotencyKey,
        linkedAccountId:      linkedAccountId      || null,
        parentTransactionId:  parentTransactionId  || null,
        goalId:               parentTx?.goalId     || null, // 🛠️ ADD THIS LINE: Without this, it won't show in Goal History
        status:               'COMPLETED',
        transactedAt:         transactedAt ? new Date(transactedAt) : new Date(),
        runningBalance:       toDecimal128(newAvailable),
      }], { session });

      // ── Account balance update ─────────────────────────────────────────────
      account.availableBalance = toDecimal128(newAvailable);
      await account.save({ session });

      // ── Goal synchronisation — only triggered on goal-related reversals ─────
      if (direction === 'REVERSAL' && parentTx?.goalId) {
        const goal = await Goal.findOne({ _id: parentTx.goalId, userId }).session(session);
        if (goal) {
          const currentAmt  = new Decimal(goal.currentAmount.toString());
          const reversalAmt = new Decimal(safeAmount.toString());
          const targetAmt   = new Decimal(goal.targetAmount.toString());

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

      // ── Commit ─────────────────────────────────────────────────────────────
      await session.commitTransaction();
      reconcileAfterTransaction(accountId, userId);

      // ── Fire-and-forget notifications — non-blocking, never throws ─────────
      const isExpense    = transactionType === 'EXPENSE';
      const isTransfer   = TRANSFER_DIRECTIONS.has(direction);
      const amountDecimal = new Decimal(safeAmount.toString());
      const minBalance    = new Decimal(account.minBalance?.toString() || '0');
      const accountName   = account.name || 'Account';

      if (isExpense && minBalance.greaterThan(0) && newAvailable.lessThan(minBalance)) {
        createNotification(
          userId,
          `Balance Alert: '${accountName}' is below the minimum threshold. Current balance: ₹${newAvailable.toFixed(2)}.`,
          'low_balance'
        ).catch((e) => console.warn('[notify] Low balance notification failed:', e.message));
      } else if (amountDecimal.greaterThanOrEqualTo(LARGE_TX_THRESHOLD)) {
        const actionWord = isTransfer ? 'transferred' : isExpense ? 'debited' : 'credited';
        createNotification(
          userId,
          `Transaction Alert: ₹${amountDecimal.toFixed(2)} was ${actionWord} on '${accountName}'.`,
          'large_transaction'
        ).catch((e) => console.warn('[notify] Large transaction notification failed:', e.message));
      }

      return res.status(201).json({
        success:          true,
        txid:             newLedger._id,
        availableBalance: newAvailable.toFixed(2),
      });

    } catch (error) {
      if (session.inTransaction()) await session.abortTransaction().catch(() => {});

      const isVersionError  = error.name === 'VersionError';
      const isWriteConflict = error.code === 112 || error.hasErrorLabel?.('TransientTransactionError');

      if ((isVersionError || isWriteConflict) && attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, Math.random() * 50 * attempt));
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
//
// Initiates a dual-leg account-to-account transfer via the accountTransfer
// service. Both ledger legs and balance updates are written atomically inside
// initiateTransfer. Reconciliation runs asynchronously on both accounts after commit.

exports.accountTransfer = async (req, res, next) => {
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

    if (input.idempotencyKey.length < 8) {
      throw new StringValidationError('idempotencyKey must be at least 8 characters');
    }
  } catch (error) {
    return errRes(res, 400, error.message);
  }

  const {
    fromAccountId, toAccountId, amount: safeAmount,
    category: safeCategory, description: safeDescription,
    idempotencyKey, transactedAt,
  } = input;

  if (!mongoose.Types.ObjectId.isValid(fromAccountId)) return errRes(res, 400, 'Invalid fromAccountId');
  if (!mongoose.Types.ObjectId.isValid(toAccountId))   return errRes(res, 400, 'Invalid toAccountId');
  if (fromAccountId.toString() === toAccountId.toString()) {
    return errRes(res, 400, 'fromAccountId and toAccountId must not be the same account');
  }

  try {
    const result = await initiateTransfer({
      userId, fromAccountId, toAccountId, safeAmount,
      category: safeCategory, idempotencyKey,
      description: safeDescription, transactedAt,
    });

    if (result.duplicate) return res.status(409).json({ success: true, ...result });

    reconcileAfterTransaction(fromAccountId, userId);
    reconcileAfterTransaction(toAccountId, userId);

    return res.status(201).json({ success: true, ...result });
  } catch (error) {
    if (error instanceof TransferError) return errRes(res, error.statusCode, error.message);
    return next(error);
  }
};

// ─── 3. getHistory ────────────────────────────────────────────────────────────
//
// Cursor-based paginated transaction history. Supports filtering by account,
// category, status, and date range. Reversal pairs are excluded from results
// so the history reflects the user's net financial picture, not internal
// correction mechanics.
exports.getHistory = async (req, res, next) => {
  try {
    const userId = req.user.id;
    // 1. ADDED 'type' and 'searchQuery' to the destructuring
    const { accountId, category, limit = 20, lastId, status, startDate, endDate, type, searchQuery } = req.query;

    const query = { userId: new mongoose.Types.ObjectId(userId) };
    query.status = VALID_STATUSES.has(status) ? status : 'COMPLETED';

    if (accountId) {
      if (!mongoose.Types.ObjectId.isValid(accountId)) return errRes(res, 400, 'Invalid accountId');
      query.accountId = new mongoose.Types.ObjectId(accountId);
    }

    if (startDate || endDate) {
      query.transactedAt = {};
      if (startDate) query.transactedAt.$gte = new Date(startDate);
      if (endDate)   query.transactedAt.$lte = new Date(endDate);
    }

    if (category) query.category = sanitizeCategory(category);

    // 2. ADDED: Filter by Income/Expense/Transfer
    if (type) {
      query.transactionType = type.toUpperCase();
    }

    // Cursor pagination (Uses $or)
    if (lastId) {
      const lastTx = await Ledger.findById(lastId).select('transactedAt').lean();
      if (lastTx) {
        query.$or = [
          { transactedAt: { $lt: lastTx.transactedAt } },
          { transactedAt: lastTx.transactedAt, _id: { $lt: new mongoose.Types.ObjectId(lastId) } },
        ];
      }
    }

    // 3. ADDED: Text Search (Safely handles existing $or from cursor)
    if (searchQuery) {
      const searchOr = [
        { category: { $regex: searchQuery, $options: 'i' } },
        { description: { $regex: searchQuery, $options: 'i' } }
      ];

      if (query.$or) {
        // If the cursor already created an $or, we must wrap both in an $and
        query.$and = [
          { $or: query.$or },
          { $or: searchOr }
        ];
        delete query.$or; // Clean up the top-level $or
      } else {
        query.$or = searchOr;
      }
    }

    // Exclude reversed originals and their reversal entries
    const reversalScope = accountId
      ? { userId: new mongoose.Types.ObjectId(userId), accountId: new mongoose.Types.ObjectId(accountId) }
      : { userId: new mongoose.Types.ObjectId(userId) };

    const reversedParentIds = await Ledger.distinct('parentTransactionId', {
      ...reversalScope,
      direction:            'REVERSAL',
      parentTransactionId:  { $ne: null },
    });

    query.direction = { $ne: 'REVERSAL' };
    if (reversedParentIds.length > 0) {
      query._id = { $nin: reversedParentIds };
    }

    const parsedLimit = Math.min(parseInt(limit, 10) || 20, 100);

    const history = await Ledger.find(query)
      .populate('accountId', 'name')
      .sort({ createdAt: -1, _id: -1 })
      .limit(parsedLimit)
      .lean();

    const nextCursor = history.length === parsedLimit && history.length > 0 
      ? history[history.length - 1]._id.toString() 
      : null;

    return res.status(200).json({
      success: true,
      count:   history.length,
      nextCursor: nextCursor,
      data:    history.map(formatLedgerEntry),
    });

  } catch (error) {
    return next(error);
  }
};
// ─── 4. voidTransaction ───────────────────────────────────────────────────────
//
// Marks a COMPLETED ledger entry as VOIDED and reverses its balance impact.
// Unlike REVERSAL, VOID does not create a new ledger entry — it mutates the
// status of the original. Use only for pre-settlement corrections.

exports.voidTransaction = async (req, res, next) => {
  const { transactionId } = req.params;
  const userId = req.user.id;

  if (!mongoose.Types.ObjectId.isValid(transactionId)) {
    return errRes(res, 400, 'Invalid transactionId');
  }

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

      const { balanceChange, reservedChange } = computeReversalDelta(
        ledger.direction,
        ledger.transactionType,
        ledger.amount.toString()
      );

      const newAvailable = new Decimal(account.availableBalance.toString()).plus(balanceChange);
      const newReserved  = new Decimal(account.reservedBalance.toString()).plus(reservedChange);

      if (newAvailable.isNegative()) {
        await session.abortTransaction();
        return errRes(res, 400, 'Voiding this transaction would result in a negative balance');
      }

      ledger.status = 'VOIDED';
      await ledger.save({ session });

      account.availableBalance = toDecimal128(newAvailable);
      account.reservedBalance  = toDecimal128(newReserved);
      await account.save({ session });

      // Synchronise goal progress if the voided entry was goal-linked.
      if (ledger.goalId) {
        const goal = await Goal.findOne({ _id: ledger.goalId, userId }).session(session);
        if (goal) {
          const amt = new Decimal(ledger.amount.toString());
          if (ledger.direction === 'GOAL_ALLOCATION') {
            const newAmt = new Decimal(goal.currentAmount.toString()).minus(amt);
            goal.currentAmount = newAmt.toNumber();
            if (newAmt.lessThan(goal.targetAmount)) goal.status = 'active';
          } else if (ledger.direction === 'GOAL_DEALLOCATION') {
            const newAmt = new Decimal(goal.currentAmount.toString()).plus(amt);
            goal.currentAmount = newAmt.toNumber();
            if (newAmt.greaterThanOrEqualTo(goal.targetAmount)) goal.status = 'completed';
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
        await new Promise((r) => setTimeout(r, Math.random() * 50 * attempt));
        continue;
      }

      return next(error);
    } finally {
      session.endSession();
    }
  }
};

// ─── 5. getLatestTransactions ─────────────────────────────────────────────────
//
// Returns the 5 most recent settled transactions for the home screen widget.
// Reversal entries and their reversed originals are excluded so the list
exports.getLatestTransactions = async (req, res, next) => {
  try {
    const userId = req.user.id;

    const reversedParentIds = await Ledger.distinct('parentTransactionId', {
      userId,
      direction:           'REVERSAL',
      parentTransactionId: { $ne: null },
    });

    // Convert to string set for fast lookup
    const reversedSet = new Set(reversedParentIds.map(id => id.toString()));

    const query = {
      userId:    new mongoose.Types.ObjectId(userId),
      status:    'COMPLETED',
      direction: { $ne: 'REVERSAL' },
    };

    // ❌ Removed: query._id = { $nin: reversedParentIds }
    // Now we include reversed originals but flag them instead

    const latestTransactions = await Ledger.find(query)
      .populate('accountId', 'name')
      .sort({ createdAt: -1, _id: -1 })
      .limit(5)
      .lean();

    return res.status(200).json({
      success: true,
      count:   latestTransactions.length,
      data:    latestTransactions.map(tx => ({
        ...formatLedgerEntry(tx),
        isCancelled: reversedSet.has(tx._id.toString()), // 👈 flag for Flutter
      })),
    });
  } catch (error) {
    return next(error);
  }
};
// ─── 6. reserveFunds ──────────────────────────────────────────────────────────
//
// Moves funds between availableBalance and reservedBalance on a single account.
// RESERVE: locks funds (available ↓, reserved ↑).
// RELEASE: unlocks funds (available ↑, reserved ↓).
// Both actions are fully reversible via processTransaction with direction REVERSAL.

exports.reserveFunds = async (req, res, next) => {
  const userId = req.user.id;
  let input;

  try {
    const missing = ['accountId', 'amount', 'action', 'idempotencyKey'].find((f) => !req.body[f]);
    if (missing) throw new Error(`${missing} is required`);

    input = {
      accountId:      req.body.accountId,
      amount:         parseAmount(req.body.amount),
      action:         req.body.action.toUpperCase(),
      category:       sanitizeCategory(req.body.category || 'System Reserve'),
      description:    sanitizeOptionalDescription(req.body.description),
      idempotencyKey: assertString(req.body.idempotencyKey, 'idempotencyKey', { maxLength: 128 }),
    };

    if (input.idempotencyKey.length < 8) {
      throw new StringValidationError('idempotencyKey must be at least 8 characters');
    }
    if (!['RESERVE', 'RELEASE'].includes(input.action)) {
      throw new Error("action must be 'RESERVE' or 'RELEASE'");
    }
  } catch (error) {
    return errRes(res, 400, error.message);
  }

  const {
    accountId, amount: safeAmount, action,
    category: safeCategory, description: safeDescription, idempotencyKey,
  } = input;

  if (!mongoose.Types.ObjectId.isValid(accountId)) return errRes(res, 400, 'Invalid accountId');

  // ── Pre-flight reads — outside the transaction lock ────────────────────────
  const [existingLedger, preFlightAccount] = await Promise.all([
    Ledger.findOne({ userId, idempotencyKey }).lean(),
    Account.findOne({ _id: accountId, userId }).lean(),
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
      if (!account) {
        await session.abortTransaction();
        return errRes(res, 404, 'Account not found');
      }

      const currentAvailable = new Decimal(account.availableBalance.toString());
      const currentReserved  = new Decimal(account.reservedBalance.toString());
      const moveAmount       = new Decimal(safeAmount.toString());

      let newAvailable, newReserved, direction;

      if (action === 'RESERVE') {
        direction    = 'RESERVED_IN';
        newAvailable = currentAvailable.minus(moveAmount);
        newReserved  = currentReserved.plus(moveAmount);

        if (newAvailable.isNegative()) {
          await session.abortTransaction();
          return errRes(res, 400, `Insufficient available balance to reserve ₹${moveAmount.toFixed(2)}`);
        }
      } else {
        direction    = 'RESERVED_OUT';
        newAvailable = currentAvailable.plus(moveAmount);
        newReserved  = currentReserved.minus(moveAmount);

        if (newReserved.isNegative()) {
          await session.abortTransaction();
          return errRes(res, 400, `Insufficient reserved balance to release ₹${moveAmount.toFixed(2)}`);
        }
      }

      const [newLedger] = await Ledger.create([{
        userId,
        accountId,
        amount:         toDecimal128(safeAmount),
        transactionType: 'RESERVE',
        direction,
        category:       safeCategory,
        description:    safeDescription,
        idempotencyKey,
        status:         'COMPLETED',
        transactedAt:   new Date(),
        runningBalance: toDecimal128(newAvailable),
      }], { session });

      account.availableBalance = toDecimal128(newAvailable);
      account.reservedBalance  = toDecimal128(newReserved);
      await account.save({ session });

      await session.commitTransaction();
      reconcileAfterTransaction(accountId, userId);

      return res.status(201).json({
        success:          true,
        action,
        txid:             newLedger._id,
        availableBalance: newAvailable.toFixed(2),
        reservedBalance:  newReserved.toFixed(2),
      });

    } catch (error) {
      if (session.inTransaction()) await session.abortTransaction().catch(() => {});

      const isVersionError  = error.name === 'VersionError';
      const isWriteConflict = error.code === 112 || error.hasErrorLabel?.('TransientTransactionError');

      if ((isVersionError || isWriteConflict) && attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, Math.random() * 50 * attempt));
        continue;
      }

      if (error.code === 11000) return errRes(res, 409, 'Duplicate transaction detected');
      return next(error);

    } finally {
      session.endSession();
    }
  }
};