const mongoose = require('mongoose');
const Ledger = require('../models/Ledger');
const Account = require('../models/Account');

/**
 * Atomic Transaction Handler
 * Updated to handle: Normal Income/Expense, Debt (Credit/Debit), and Goals
 */
exports.addTransaction = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { 
      userId, 
      accountId, 
      amount, 
      transactionType, // INCOME, EXPENSE, DEBT_MANAGEMENT, etc.
      direction,       // NORMAL, CREDIT, DEBIT, GOAL_ALLOCATION
      category, 
      description, 
      idempotencyKey 
    } = req.body;

    if (!idempotencyKey) {
      return res.status(400).json({ error: 'idempotencyKey is required' });
    }

    const existingLedger = await Ledger.findOne({ userId, idempotencyKey }).session(session);
    if (existingLedger) {
      await session.abortTransaction();
      return res.status(409).json({ message: 'Duplicate transaction', ledger: existingLedger });
    }

    const account = await Account.findOne({ _id: accountId, userId }).session(session);
    if (!account) throw new Error('Account not found');

    const amountVal = parseFloat(amount);
    const availableVal = parseFloat(account.availableBalance.toString());

    // --- Business Logic for Balance Impact ---
    let balanceChange = 0;
    let reservedChange = 0;

    // Logic: Income is NORMAL + CREDIT-like impact
    if (transactionType === 'INCOME' && direction === 'NORMAL') {
      balanceChange = amountVal;
    } 
    // Logic: Expense is NORMAL + DEBIT-like impact
    else if (transactionType === 'EXPENSE' && direction === 'NORMAL') {
      balanceChange = -amountVal;
    }
    // Logic: Credit from Creditor (Money In)
    else if (direction === 'CREDIT') {
      balanceChange = amountVal;
    }
    // Logic: Debit to Debtor (Money Out/Loan given)
    else if (direction === 'DEBIT') {
      balanceChange = -amountVal;
    }
    // Logic: Internal Goal Movement
    else if (direction === 'GOAL_ALLOCATION') {
      balanceChange = -amountVal;
      reservedChange = amountVal;
    }
    else if (direction === 'GOAL_DEALLOCATION') {
      balanceChange = amountVal;
      reservedChange = -amountVal;
    }

    // Invariant Check: Prevent spending what you don't have
    if (balanceChange < 0 && availableVal < Math.abs(balanceChange)) {
      await session.abortTransaction();
      return res.status(400).json({ error: 'Insufficient funds for this operation' });
    }

    // 1. Create Ledger Entry
    const [newLedger] = await Ledger.create([{
      userId,
      accountId,
      amount: mongoose.Types.Decimal128.fromString(amount.toString()),
      transactionType,
      direction,
      category,
      description,
      idempotencyKey,
      status: 'COMPLETED'
    }], { session });

    // 2. Update Account Balance
    const updatedAccount = await Account.findOneAndUpdate(
      { _id: accountId },
      { $inc: { availableBalance: balanceChange, reservedBalance: reservedChange } },
      { session, new: true, runValidators: true }
    );

    if (parseFloat(updatedAccount.availableBalance.toString()) < 0) {
      throw new Error('Critical: Negative balance safety triggered');
    }

    await session.commitTransaction();
    res.status(201).json({ success: true, availableBalance: updatedAccount.availableBalance.toString() });

  } catch (error) {
    await session.abortTransaction();
    res.status(500).json({ error: error.message });
  } finally {
    session.endSession();
  }
};

/**
 * Paginated History with Advanced Financial Filters
 */
exports.getHistory = async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 10, lastId, accountId, filterType } = req.query;

    let query = { userId };
    if (accountId) query.accountId = accountId;
    if (lastId) query._id = { $lt: lastId };

    // Advanced Filtering Logic
    switch (filterType) {
      case 'INCOME': // Pure earned income
        query.transactionType = 'INCOME';
        query.direction = 'NORMAL';
        break;
      case 'EXPENSE': // Pure spending
        query.transactionType = 'EXPENSE';
        query.direction = 'NORMAL';
        break;
      case 'CREDITOR_CREDIT': // Loans received
        query.direction = 'CREDIT';
        query.transactionType = { $ne: 'INCOME' };
        break;
      case 'DEBITOR_DEBIT': // Loans given out
        query.direction = 'DEBIT';
        query.transactionType = { $ne: 'EXPENSE' };
        break;
      case 'GOAL_RESERVED': // Goal movements
        query.direction = { $in: ['GOAL_ALLOCATION', 'GOAL_DEALLOCATION'] };
        break;
      case 'REVERSED': // Reversals and voided entries
        query.$or = [{ status: 'VOIDED' }, { transactionType: 'REVERSAL' }];
        break;
      default:
        query.status = { $ne: 'FAILED' };
    }

    const history = await Ledger.find(query).sort({ _id: -1 }).limit(parseInt(limit)).lean();

    res.status(200).json({
      count: history.length,
      nextCursor: history.length === parseInt(limit) ? history[history.length - 1]._id : null,
      history
    });
  } catch (error) {
    res.status(500).json({ error: 'History fetch failed' });
  }
};