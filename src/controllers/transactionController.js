const mongoose = require('mongoose');
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
      return res.status(400).json({ error: 'Header [Idempotency-Key] missing' });
    }

    const existingLedger = await Ledger.findOne({ userId, idempotencyKey }).session(session);
    if (existingLedger) {
      await session.abortTransaction();
      return res.status(409).json({ message: 'Conflict: Duplicate idempotency key', ledger: existingLedger });
    }

    const account = await Account.findOne({ _id: accountId, userId }).session(session);
    if (!account) throw new Error('Account target not found');

    const amountVal = parseFloat(amount);
    const availableVal = parseFloat(account.availableBalance.toString());

    // --- 2. ACCOUNTING LOGIC ENGINE ---
    let balanceChange = 0;
    let reservedChange = 0;

    if (transactionType === 'REVERSAL') {
      if (!parentTransactionId) throw new Error('Parent ID required for reversal trace');

      const original = await Ledger.findById(parentTransactionId).session(session);
      if (!original || original.status === 'VOIDED') throw new Error('Original record unavailable or already voided');

      const wasMoneyOut = original.direction === 'DEBIT' ||
        (original.transactionType === 'EXPENSE' && original.direction === 'NORMAL') ||
        original.direction === 'GOAL_ALLOCATION';

      balanceChange = wasMoneyOut ? amountVal : -amountVal;

      if (original.direction === 'GOAL_ALLOCATION') reservedChange = -amountVal;
      if (original.direction === 'GOAL_DEALLOCATION') reservedChange = amountVal;

      original.status = 'VOIDED';
      await original.save({ session });

    } else {
      if (transactionType === 'INCOME' && direction === 'NORMAL') balanceChange = amountVal;
      else if (transactionType === 'EXPENSE' && direction === 'NORMAL') balanceChange = -amountVal;
      else if (direction === 'CREDIT') balanceChange = amountVal; 
      else if (direction === 'DEBIT') balanceChange = -amountVal;  
      else if (direction === 'GOAL_ALLOCATION') { balanceChange = -amountVal; reservedChange = amountVal; }
      else if (direction === 'GOAL_DEALLOCATION') { balanceChange = amountVal; reservedChange = -amountVal; }
    }

    // --- 3. INVARIANT SAFETY GUARD ---
    if (balanceChange < 0 && availableVal < Math.abs(balanceChange)) {
      await session.abortTransaction();
      return res.status(400).json({ error: 'FUNDS_INSUFFICIENT: Transaction violates minimum balance' });
    }

    // --- 4. EXECUTE PERSISTENCE ---
    const [newLedger] = await Ledger.create([{
      userId, accountId,
      amount: mongoose.Types.Decimal128.fromString(amount.toString()),
      transactionType, direction, category, description, idempotencyKey,
      parentTransactionId: parentTransactionId || null,
      status: 'COMPLETED'
    }], { session });

    const updatedAccount = await Account.findOneAndUpdate(
      { _id: accountId },
      { $inc: { availableBalance: balanceChange, reservedBalance: reservedChange } },
      { session, new: true, runValidators: true }
    );

    await session.commitTransaction();
    res.status(201).json({
      success: true,
      txid: newLedger._id,
      balance: updatedAccount.availableBalance.toString()
    });

  } catch (error) {
    await session.abortTransaction();
    res.status(500).json({ error: error.message });
  } finally {
    session.endSession();
  }
};

/**
 * @description Retrieves transaction history with server-side filtering and pagination.
 */
exports.getHistory = async (req, res) => {
  try {
    const { userId } = req.params;
    const { 
      accountId, 
      transactionType, 
      category, 
      limit = 20, 
      page = 1 
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

    // 2. Execute Query with Keyset Pagination Indexing
    const history = await Ledger.find(query)
      .sort({ createdAt: -1 }) // Optimized by your { userId: 1, _id: -1 } index
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit))
      .lean();

    // 3. Format Response for Flutter
    const data = history.map(tx => ({
      ...tx,
      amount: tx.amount.toString(), // Convert Decimal128 for JSON safety
      id: tx._id
    }));

    return res.status(200).json({
      success: true,
      results: data.length,
      page: parseInt(page),
      data
    });

  } catch (error) {
    console.error('FETCH_HISTORY_ERROR:', error);
    return res.status(500).json({ error: 'Internal server error while fetching history' });
  }
};