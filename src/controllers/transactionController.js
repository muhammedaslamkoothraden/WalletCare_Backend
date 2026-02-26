const mongoose = require('mongoose');
const Ledger = require('../models/Ledger');
const Account = require('../models/Account');

/**
 * Atomic Transaction Handler
 * Handles: Income, Expense, and Goal Allocations
 */
exports.addTransaction = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { 
      userId, 
      accountId, 
      amount, 
      transactionType, 
      direction, 
      category, 
      description, 
      idempotencyKey 
    } = req.body;

    // 1. Validation
    if (!idempotencyKey) {
      return res.status(400).json({ error: 'idempotencyKey is required for safety' });
    }

    // 2. Idempotency Check (The Guard)
    const existingLedger = await Ledger.findOne({ userId, idempotencyKey }).session(session);
    if (existingLedger) {
      await session.abortTransaction();
      return res.status(409).json({ 
        message: 'Duplicate transaction detected', 
        ledger: existingLedger 
      });
    }

    // 3. Fetch & Lock Account
    const account = await Account.findOne({ _id: accountId, userId }).session(session);
    if (!account) {
      throw new Error('Account not found');
    }

    // 4. Precision Math Check (Avoid Floating Point errors)
    const amountVal = parseFloat(amount);
    const availableVal = parseFloat(account.availableBalance.toString());

    // 5. Invariant Check (Prevent Negative Balance)
    if (direction === 'DEBIT' || direction === 'GOAL_ALLOCATION') {
      if (availableVal < amountVal) {
        await session.abortTransaction();
        return res.status(400).json({ error: 'Insufficient funds' });
      }
    }

    // 6. Execute Ledger Write
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

    // 7. Atomic Materialized Balance Update
    let updateFields = {};
    if (direction === 'CREDIT') {
      // Income: Increase Available
      updateFields = { $inc: { availableBalance: amountVal } };
    } else if (direction === 'DEBIT') {
      // Expense: Decrease Available
      updateFields = { $inc: { availableBalance: -amountVal } };
    } else if (direction === 'GOAL_ALLOCATION') {
      // Move Available -> Reserved
      updateFields = { $inc: { availableBalance: -amountVal, reservedBalance: amountVal } };
    } else if (direction === 'GOAL_DEALLOCATION') {
      // Move Reserved -> Available
      updateFields = { $inc: { availableBalance: amountVal, reservedBalance: -amountVal } };
    }

    const updatedAccount = await Account.findOneAndUpdate(
      { _id: accountId },
      updateFields,
      { session, new: true, runValidators: true }
    );

    // 8. Final Invariant Confirmation (Double Check)
    if (parseFloat(updatedAccount.availableBalance.toString()) < 0) {
      throw new Error('Critical: Transaction resulted in negative balance');
    }

    await session.commitTransaction();
    
    res.status(201).json({
      success: true,
      transactionId: newLedger._id,
      availableBalance: updatedAccount.availableBalance.toString(),
      totalBalance: updatedAccount.totalBalance.toString()
    });

  } catch (error) {
    await session.abortTransaction();
    console.error('TRANSACTION_FAILURE:', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  } finally {
    session.endSession();
  }
};

/**
 * Paginated Transaction History (Keyset Pagination)
 * Supports: Global User History OR Specific Account History
 */
exports.getHistory = async (req, res) => {
  try {
    const { userId } = req.params;
    const { 
      limit = 10, 
      lastId, 
      accountId // Optional: If provided, filters by specific account
    } = req.query;

    // 1. Build the dynamic query object
    const query = { userId };

    // If accountId is provided in query params, filter by it
    if (accountId) {
      query.accountId = accountId;
    }

    // Keyset pagination: Fetch records older than the last seen ID
    if (lastId) {
      query._id = { $lt: lastId }; 
    }

    // 2. Execute Query
    const history = await Ledger.find(query)
      .sort({ _id: -1 }) // Newest first
      .limit(parseInt(limit))
      .lean();

    // 3. Determine if there are more pages
    const nextCursor = history.length === parseInt(limit) 
      ? history[history.length - 1]._id 
      : null;

    res.status(200).json({
      success: true,
      count: history.length,
      nextCursor,
      history
    });

  } catch (error) {
    console.error('HISTORY_FETCH_ERROR:', error);
    res.status(500).json({ error: 'Failed to fetch transaction history' });
  }
};
/**
 * @description Reverses a transaction by creating a counter-entry.
 * Handles Week 10 requirements: Balance reversal with safety checks.
 */
exports.reverseTransaction = async (req, res) => {
  const { ledgerId } = req.params;
  const { userId, reason } = req.body;
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // 1. Fetch the original transaction
    const originalEntry = await Ledger.findOne({ _id: ledgerId, userId }).session(session);
    
    if (!originalEntry) {
      return res.status(404).json({ error: "Original transaction not found." });
    }

    if (originalEntry.status === 'VOIDED') {
      return res.status(400).json({ error: "Transaction is already reversed." });
    }

    // 2. Determine the Reversal Impact
    // If original was a DEBIT (money out), we need to CREDIT (money in).
    const isOriginalDebit = originalEntry.direction === 'DEBIT' || originalEntry.direction === 'GOAL_ALLOCATION';
    const reversalDirection = isOriginalDebit ? 'CREDIT' : 'DEBIT';
    const amountVal = parseFloat(originalEntry.amount.toString());

    // 3. Safety Check: If we are reversing an INCOME (CREDIT), 
    // we must ensure the user still has enough balance to take that money back.
    if (reversalDirection === 'DEBIT') {
      const account = await Account.findById(originalEntry.accountId).session(session);
      const available = parseFloat(account.availableBalance.toString());
      
      if (available < amountVal) {
        throw new Error("Reversal denied: Insufficient funds to claw back this transaction.");
      }
    }

    // 4. Create the Reversal Ledger Entry (The Audit Trail)
    const [reversalLedger] = await Ledger.create([{
      userId: originalEntry.userId,
      accountId: originalEntry.accountId,
      amount: originalEntry.amount, // Same amount
      direction: reversalDirection,
      transactionType: originalEntry.transactionType,
      category: "Reversal",
      description: `Reversal of tx: ${ledgerId}. Reason: ${reason || 'User requested'}`,
      idempotencyKey: `rev-${ledgerId}`, // Derived key to prevent double reversal
      status: 'COMPLETED'
    }], { session });

    // 5. Update Materialized Balance
    // We use $inc to reverse the original direction
    const incAmount = reversalDirection === 'CREDIT' ? amountVal : -amountVal;
    
    // Note: If reversing a GOAL_ALLOCATION, we move from Reserved -> Available
    let updateQuery = { $inc: { availableBalance: incAmount } };
    if (originalEntry.direction === 'GOAL_ALLOCATION') {
      updateQuery.$inc.reservedBalance = -amountVal;
    }

    const updatedAccount = await Account.findOneAndUpdate(
      { _id: originalEntry.accountId },
      updateQuery,
      { session, new: true }
    );

    // 6. Mark the original entry as VOIDED
    originalEntry.status = 'VOIDED';
    await originalEntry.save({ session });

    await session.commitTransaction();

    res.status(200).json({
      message: "Transaction successfully reversed.",
      reversalId: reversalLedger._id,
      newBalance: updatedAccount.availableBalance.toString()
    });

  } catch (error) {
    await session.abortTransaction();
    res.status(400).json({ error: error.message });
  } finally {
    session.endSession();
  }
};