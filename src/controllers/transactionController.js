const mongoose = require('mongoose');
const Decimal = require('decimal.js'); // Required for safe FinTech math
const Ledger = require('../models/Ledger');
const Account = require('../models/Account');

/**
 * @description Atomic Handler for all Ledger movements.
 * Handles: INCOME, EXPENSE, DEBT, and REVERSALS.
 */
exports.processTransaction = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const {
      userId, accountId, amount, transactionType,
      direction, category, description, idempotencyKey,
      parentTransactionId // Required only for REVERSAL type
    } = req.body;

    // --- 1. PRE-FLIGHT CHECKS ---
    if (!idempotencyKey) {
      // FIX: Updated error message to accurately reflect it comes from the JSON body
      return res.status(400).json({ error: 'idempotencyKey is required in the request body' });
    }

    const existingLedger = await Ledger.findOne({ userId, idempotencyKey }).session(session);
    if (existingLedger) {
      await session.abortTransaction();
      return res.status(409).json({ message: 'Conflict: Duplicate idempotency key', ledger: existingLedger });
    }

    const account = await Account.findOne({ _id: accountId, userId }).session(session);
    if (!account) throw new Error('Account target not found');

    // FIX: Convert everything to precise Decimal objects immediately
    const safeAmount = new Decimal(amount.toString());
    const currentAvailable = new Decimal(account.availableBalance.toString());
    const currentReserved = new Decimal(account.reservedBalance.toString());

    // --- 2. ACCOUNTING LOGIC ENGINE ---
    let balanceChange = new Decimal(0);
    let reservedChange = new Decimal(0);

    if (transactionType === 'REVERSAL') {
      if (!parentTransactionId) throw new Error('Parent ID required for reversal trace');

      const original = await Ledger.findById(parentTransactionId).session(session);
      if (!original || original.status === 'VOIDED') throw new Error('Original record unavailable or already voided');

      const wasMoneyOut = original.direction === 'DEBIT' ||
        (original.transactionType === 'EXPENSE' && original.direction === 'NORMAL') ||
        original.direction === 'GOAL_ALLOCATION';

      balanceChange = wasMoneyOut ? safeAmount : safeAmount.negated();

      if (original.direction === 'GOAL_ALLOCATION') reservedChange = safeAmount.negated();
      if (original.direction === 'GOAL_DEALLOCATION') reservedChange = safeAmount;

      original.status = 'VOIDED';
      await original.save({ session });

    } else {
      if (transactionType === 'INCOME' && direction === 'NORMAL') balanceChange = safeAmount;
      else if (transactionType === 'EXPENSE' && direction === 'NORMAL') balanceChange = safeAmount.negated();
      else if (direction === 'CREDIT') balanceChange = safeAmount; 
      else if (direction === 'DEBIT') balanceChange = safeAmount.negated();  
      else if (direction === 'GOAL_ALLOCATION') { balanceChange = safeAmount.negated(); reservedChange = safeAmount; }
      else if (direction === 'GOAL_DEALLOCATION') { balanceChange = safeAmount; reservedChange = safeAmount.negated(); }
    }

    // --- 3. INVARIANT SAFETY GUARD ---
    const newAvailable = currentAvailable.plus(balanceChange);
    const newReserved = currentReserved.plus(reservedChange);

    if (newAvailable.isNegative()) {
      await session.abortTransaction();
      return res.status(400).json({ error: 'FUNDS_INSUFFICIENT: Transaction violates minimum balance' });
    }

    // --- 4. EXECUTE PERSISTENCE ---
    const [newLedger] = await Ledger.create([{
      userId, accountId,
      amount: mongoose.Types.Decimal128.fromString(safeAmount.toFixed(2)),
      transactionType, direction, category, description, idempotencyKey,
      parentTransactionId: parentTransactionId || null,
      status: 'COMPLETED'
    }], { session });

    // FIX: Update the document properties directly and call .save() 
    // This triggers the pre('save') middleware to perfectly calculate totalBalance
    account.availableBalance = mongoose.Types.Decimal128.fromString(newAvailable.toFixed(2));
    account.reservedBalance = mongoose.Types.Decimal128.fromString(newReserved.toFixed(2));
    
    await account.save({ session });

    await session.commitTransaction();
    
    res.status(201).json({
      success: true,
      txid: newLedger._id,
      // Send back the newly calculated totals directly to the Flutter app
      availableBalance: account.availableBalance.toString(),
      totalBalance: account.totalBalance.toString() 
    });

  } catch (error) {
    await session.abortTransaction();
    res.status(500).json({ error: error.message });
  } finally {
    session.endSession();
  }
};

/**
 * @description Retrieves transaction history using high-performance Keyset Pagination.
 */
exports.getHistory = async (req, res) => {
  try {
    const { userId } = req.params;
    const { 
      accountId, 
      transactionType, 
      category, 
      limit = 20, 
      lastId // FIX: Replaced 'page' with 'lastId' for cursor pagination
    } = req.query;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ error: 'Invalid User ID format' });
    }

    // 1. Build Query Object
    const query = { userId };

    if (accountId && mongoose.Types.ObjectId.isValid(accountId)) {
      query.accountId = accountId;
    }

    if (transactionType) {
      query.transactionType = transactionType.toUpperCase();
    }

    if (category) {
      query.category = category;
    }

    // FIX: Apply the Keyset Cursor
    if (lastId && mongoose.Types.ObjectId.isValid(lastId)) {
      // Fetch documents strictly older than the last one seen
      query._id = { $lt: lastId }; 
    }

    // 2. Execute Query
    const history = await Ledger.find(query)
      .sort({ _id: -1 }) // Optimized by the { userId: 1, _id: -1 } index
      .limit(parseInt(limit))
      .lean(); // No more .skip() needed!

    // 3. Format Response
    const data = history.map(tx => ({
      ...tx,
      amount: tx.amount.toString(), 
      id: tx._id
    }));

    // Determine the next cursor to send to Flutter
    const nextCursor = data.length > 0 ? data[data.length - 1].id : null;

    return res.status(200).json({
      success: true,
      results: data.length,
      nextCursor, // Flutter will pass this back as 'lastId' to get the next batch
      data
    });

  } catch (error) {
    console.error('FETCH_HISTORY_ERROR:', error);
    return res.status(500).json({ error: 'Internal server error while fetching history' });
  }
};