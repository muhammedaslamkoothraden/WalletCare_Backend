const mongoose = require('mongoose');
const Ledger = require('../models/ledger'); // Renamed from transaction
const Account = require('../models/Account'); // Renamed from wallet

/**
 * Add a transaction (Ledger-based with Atomicity)
 * POST /api/transactions
 */
exports.addTransaction = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { userId, accountId, amount, transactionType, direction, category, description, idempotencyKey } = req.body;

    // 1. Basic Validation
    if (!userId || !accountId || !amount || !transactionType || !direction || !idempotencyKey) {
      return res.status(400).json({ error: 'Missing required fields including idempotencyKey' });
    }

    // 2. Check for Duplicate Request (Idempotency)
    const existingLedger = await Ledger.findOne({ userId, idempotencyKey }).session(session);
    if (existingLedger) {
      await session.abortTransaction();
      return res.status(409).json({ message: 'Duplicate transaction detected', ledger: existingLedger });
    }

    // 3. Fetch Account
    const account = await Account.findOne({ _id: accountId, userId }).session(session);
    if (!account) {
      throw new Error('Account not found');
    }

    // 4. Prepare Decimal values
    const amountDecimal = mongoose.Types.Decimal128.fromString(amount.toString());
    const currentAvailable = parseFloat(account.availableBalance.toString());
    const transactionAmount = parseFloat(amount.toString());

    // 5. Insufficient Funds Check (For Debits/Expenses)
    if (direction === 'DEBIT' && currentAvailable < transactionAmount) {
      await session.abortTransaction();
      return res.status(400).json({ error: 'Insufficient funds' });
    }

    // 6. Create Ledger Entry
    const ledger = new Ledger({
      userId,
      accountId,
      amount: amountDecimal,
      transactionType,
      direction,
      category,
      description,
      idempotencyKey,
      status: 'COMPLETED'
    });

    // 7. Update Materialized Balance in Account
    // The account.pre('save') hook will automatically update totalBalance
    if (direction === 'CREDIT') {
      account.availableBalance = mongoose.Types.Decimal128.fromString((currentAvailable + transactionAmount).toFixed(2));
    } else if (direction === 'DEBIT') {
      account.availableBalance = mongoose.Types.Decimal128.fromString((currentAvailable - transactionAmount).toFixed(2));
    }
    // Note: 'INTERNAL' transfers (goals) don't change totalBalance, just move available -> reserved

    // 8. Atomic Save
    await ledger.save({ session });
    await account.save({ session });

    await session.commitTransaction();
    session.endSession();

    res.status(201).json({
      message: 'Transaction successful',
      transactionId: ledger._id,
      newBalance: account.availableBalance.toString()
    });

  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error('Transaction Error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
};

/**
 * Get History
 */
exports.getHistory = async (req, res) => {
  try {
    const { userId } = req.params;
    const history = await Ledger.find({ userId }).sort({ createdAt: -1 });

    res.status(200).json({
      count: history.length,
      history
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch history' });
  }
};