const Transaction = require('../models/transaction');
const Wallet = require('../models/wallet');

/**
 * Add a transaction for a user
 * POST /api/transactions
 */
exports.addTransaction = async (req, res) => {
  try {
    const { userId, walletId, amount, type, category, description } = req.body;

    // Input validation
    if (!userId || !walletId || !amount || !type || !category) {
      return res.status(400).json({ error: 'Missing required fields: userId, walletId, amount, type, category' });
    }
    // Amount validation
    if (
      typeof amount !== 'number' ||
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      return res.status(400).json({
        error: 'Amount must be a positive number'
      });
    }

    // Fetch wallet
    const wallet = await Wallet.findById(walletId);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

    // Insufficient funds check for expenses
    if (type === 'expense' && wallet.availableBalance < amount) {
      return res.status(400).json({
        error: 'Insufficient funds',
        currentBalance: wallet.availableBalance,
        attemptedAmount: amount
      });
    }

    // Create transaction
    const transaction = new Transaction({ userId, walletId, amount, type, category, description });

    // Update wallet balance
    if (type === 'income') wallet.availableBalance += amount;
    if (type === 'expense') wallet.availableBalance -= amount;

    // Save both
    await transaction.save();
    await wallet.save();


    res.status(201).json({
      message: 'Transaction successful',
      transaction: {
        id: transaction._id,
        userId,
        walletId,
        amount,
        type,
        category,
        description,
        createdAt: transaction.createdAt
      },
      newBalance: wallet.availableBalance
    });
  } catch (error) {
    console.error('Add transaction error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Get transaction history for a user
 * GET /api/transactions/history/:userId
 */
exports.getHistory = async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ error: 'UserId is required' });

    const history = await Transaction.find({ userId }).sort({ createdAt: -1 });

    res.status(200).json({
      message: history.length ? 'Transaction history fetched' : 'No transactions found',
      history
    });
  } catch (error) {
    console.error('Get history error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

