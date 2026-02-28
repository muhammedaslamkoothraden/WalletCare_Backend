const mongoose = require('mongoose');
const Decimal = require('decimal.js');
const Ledger = require('../models/Ledger');
const Account = require('../models/Account');

/**
 * @description Atomic Handler for all Ledger movements.
 * Optimized for Mongoose Virtuals and safe Decimal math.
 */
exports.processTransaction = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const {
      userId, accountId, amount, transactionType,
      direction, category, description, idempotencyKey,
      parentTransactionId 
    } = req.body;

    // --- 1. PRE-FLIGHT CHECKS ---
    if (!idempotencyKey) {
      return res.status(400).json({ error: 'idempotencyKey is required' });
    }

    const existingLedger = await Ledger.findOne({ userId, idempotencyKey }).session(session);
    if (existingLedger) {
      await session.abortTransaction();
      return res.status(409).json({ message: 'Conflict: Duplicate idempotency key', ledger: existingLedger });
    }

    const account = await Account.findOne({ _id: accountId, userId }).session(session);
    if (!account) {
      const error = new Error('Account target not found');
      error.status = 404;
      throw error;
    }

    // --- 2. PRECISE MATH SETUP ---
    const safeAmount = new Decimal(amount.toString());
    const currentAvailable = new Decimal(account.availableBalance.toString());
    const currentReserved = new Decimal(account.reservedBalance.toString());

    let balanceChange = new Decimal(0);
    let reservedChange = new Decimal(0);

    // --- 3. LOGIC ENGINE ---
    if (transactionType === 'REVERSAL') {
      if (!parentTransactionId) throw new Error('Parent ID required for reversal');

      const original = await Ledger.findById(parentTransactionId).session(session);
      if (!original || original.status === 'VOIDED') throw new Error('Original record unavailable or voided');

      // Determine if original was money leaving the available pool
      const wasMoneyOut = original.direction === 'DEBIT' ||
        (original.transactionType === 'EXPENSE' && original.direction === 'NORMAL') ||
        original.direction === 'GOAL_ALLOCATION';

      balanceChange = wasMoneyOut ? safeAmount : safeAmount.negated();

      if (original.direction === 'GOAL_ALLOCATION') reservedChange = safeAmount.negated();
      if (original.direction === 'GOAL_DEALLOCATION') reservedChange = safeAmount;

      original.status = 'VOIDED';
      await original.save({ session });

    } else {
      // Standard Logic Mapping
      if (transactionType === 'INCOME' && direction === 'NORMAL') balanceChange = safeAmount;
      else if (transactionType === 'EXPENSE' && direction === 'NORMAL') balanceChange = safeAmount.negated();
      else if (direction === 'CREDIT') balanceChange = safeAmount; 
      else if (direction === 'DEBIT') balanceChange = safeAmount.negated();  
      else if (direction === 'GOAL_ALLOCATION') { 
        balanceChange = safeAmount.negated(); 
        reservedChange = safeAmount; 
      }
      else if (direction === 'GOAL_DEALLOCATION') { 
        balanceChange = safeAmount; 
        reservedChange = safeAmount.negated(); 
      }
    }

    // --- 4. INVARIANT SAFETY GUARD ---
    const newAvailable = currentAvailable.plus(balanceChange);
    const newReserved = currentReserved.plus(reservedChange);

    if (newAvailable.isNegative()) {
      await session.abortTransaction();
      return res.status(400).json({ error: 'FUNDS_INSUFFICIENT' });
    }

    // --- 5. EXECUTE PERSISTENCE ---
    const [newLedger] = await Ledger.create([{
      userId, accountId,
      amount: mongoose.Types.Decimal128.fromString(safeAmount.toFixed(2)),
      transactionType, direction, category, description, idempotencyKey,
      parentTransactionId: parentTransactionId || null,
      status: 'COMPLETED'
    }], { session });

    // Update Account balances
    account.availableBalance = mongoose.Types.Decimal128.fromString(newAvailable.toFixed(2));
    account.reservedBalance = mongoose.Types.Decimal128.fromString(newReserved.toFixed(2));
    
    // Save account (Virtual totalBalance will be calculated on the fly in the response)
    await account.save({ session });

    await session.commitTransaction();
    
    res.status(201).json({
      success: true,
      txid: newLedger._id,
      availableBalance: account.availableBalance.toString(),
      reservedBalance: account.reservedBalance.toString(),
      // totalBalance comes from the Mongoose Virtual we set up
      totalBalance: account.totalBalance 
    });

  } catch (error) {
    if (session.inAtomicityPlaceholder) await session.abortTransaction();
    next(error); // Passes error to the Global Handler in app.js
  } finally {
    session.endSession();
  }
};

/**
 * @description Retrieves transaction history using Keyset Pagination.
 */
exports.getHistory = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { accountId, transactionType, category, limit = 20, lastId } = req.query;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ error: 'Invalid User ID format' });
    }

    const query = { userId };
    if (accountId && mongoose.Types.ObjectId.isValid(accountId)) query.accountId = accountId;
    if (transactionType) query.transactionType = transactionType.toUpperCase();
    if (category) query.category = category;
    if (lastId && mongoose.Types.ObjectId.isValid(lastId)) query._id = { $lt: lastId };

    const history = await Ledger.find(query)
      .sort({ _id: -1 })
      .limit(parseInt(limit))
      .lean();

    const data = history.map(tx => ({
      ...tx,
      amount: tx.amount.toString(), 
      id: tx._id
    }));

    const nextCursor = data.length > 0 ? data[data.length - 1].id : null;

    return res.status(200).json({
      success: true,
      results: data.length,
      nextCursor,
      data
    });

  } catch (error) {
    next(error);
  }
};