const mongoose = require('mongoose');
const Decimal = require('decimal.js');
const Ledger = require('../models/Ledger');
const Account = require('../models/Account');

/**
 * @description Atomic Handler for all Ledger movements.
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
    if (!idempotencyKey) return res.status(400).json({ error: 'idempotencyKey is required' });

    const existingLedger = await Ledger.findOne({ userId, idempotencyKey }).session(session);
    if (existingLedger) {
      await session.abortTransaction();
      return res.status(409).json({ message: 'Conflict: Duplicate key', ledger: existingLedger });
    }

    const account = await Account.findOne({ _id: accountId, userId }).session(session);
    if (!account) throw new Error('Account target not found');

    // --- 2. PRECISE MATH SETUP ---
    const safeAmount = new Decimal(amount.toString());
    const currentAvailable = new Decimal(account.availableBalance.toString());
    const currentReserved = new Decimal(account.reservedBalance.toString());

    let balanceChange = new Decimal(0);
    let reservedChange = new Decimal(0);

    // --- 3. LOGIC ENGINE ---
    if (transactionType === 'REVERSAL') {
      if (!parentTransactionId) throw new Error('Parent ID required');
      const original = await Ledger.findById(parentTransactionId).session(session);
      if (!original || original.status === 'VOIDED') throw new Error('Original unavailable');

      const wasMoneyOut = original.direction === 'DEBIT' || 
                         original.transactionType === 'EXPENSE' || 
                         original.direction === 'GOAL_ALLOCATION';

      balanceChange = wasMoneyOut ? safeAmount : safeAmount.negated();
      if (original.direction === 'GOAL_ALLOCATION') reservedChange = safeAmount.negated();
      
      original.status = 'VOIDED';
      await original.save({ session });
    } else {
      // Standard Mapping
      if (transactionType === 'INCOME') balanceChange = safeAmount;
      else if (transactionType === 'EXPENSE') balanceChange = safeAmount.negated();
      else if (direction === 'GOAL_ALLOCATION') { 
        balanceChange = safeAmount.negated(); 
        reservedChange = safeAmount; 
      }
      else if (direction === 'GOAL_DEALLOCATION') { 
        balanceChange = safeAmount; 
        reservedChange = safeAmount.negated(); 
      }
    }

    // --- 4. SAFETY GUARD ---
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

    account.availableBalance = mongoose.Types.Decimal128.fromString(newAvailable.toFixed(2));
    account.reservedBalance = mongoose.Types.Decimal128.fromString(newReserved.toFixed(2));
    await account.save({ session });

    await session.commitTransaction();
    
    res.status(201).json({
      success: true,
      txid: newLedger._id,
      availableBalance: account.availableBalance.toString(),
      reservedBalance: account.reservedBalance.toString()
    });

  } catch (error) {
    if (session.inAtomicityPlaceholder) await session.abortTransaction();
    next(error);
  } finally {
    session.endSession();
  }
};

//  history
exports.getHistory = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { accountId, category, limit = 20, lastId } = req.query;

    const query = { userId: new mongoose.Types.ObjectId(userId) };

    if (accountId && mongoose.Types.ObjectId.isValid(accountId)) {
      query.accountId = new mongoose.Types.ObjectId(accountId);
    }

    // New: Filter by category if provided
    if (category && category !== 'All Categories') {
      query.category = category;
    }

    const history = await Ledger.find(query)
      .sort({ _id: -1 })
      .limit(parseInt(limit))
      .lean();

    return res.status(200).json({
      success: true,
      data: history.map(tx => ({ ...tx, amount: tx.amount.toString() }))
    });
  } catch (error) {
    next(error);
  }
};