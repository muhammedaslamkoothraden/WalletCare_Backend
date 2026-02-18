const Wallet = require('../models/wallet');

/**
 * Get wallet balances by userId
 * Returns availableBalance, savingsBalance, and totalBalance
 */
exports.getWalletByUserId = async (req, res) => {
  try {
    const { userId } = req.params;
    

    // Validate input
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ error: 'UserId parameter is required and must be a valid ObjectId.' });
    }

    // Fetch wallet
    const wallet = await Wallet.findOne({ userId });

    if (!wallet) {
      return res.status(404).json({ error: 'Wallet not found for this user.' });
    }

    // Return balances
    res.status(200).json({
      availableBalance: wallet.availableBalance,
      savingsBalance: wallet.savingsBalance,
      totalBalance: wallet.totalBalance
    });

  } catch (error) {
    console.error('Error fetching wallet:', error);
    res.status(500).json({ error: 'Internal server error.' });
  }
};
