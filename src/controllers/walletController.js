const mongoose = require('mongoose');
const Wallet = require('../models/wallet');

exports.getWalletByUserId = async (req, res) => {
  try {
    const { userId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({
        error: 'UserId must be a valid MongoDB ObjectId'
      });
    }

    const wallet = await Wallet.findOne({ userId });

    if (!wallet) {
      return res.status(404).json({
        error: 'Wallet not found for this user'
      });
    }

    return res.status(200).json({
      availableBalance: wallet.availableBalance,
      savingsBalance: wallet.savingsBalance,
      totalBalance: wallet.totalBalance
    });

  } catch (error) {
    console.error('Error fetching wallet:', error);
    return res.status(500).json({
      error: 'Internal server error'
    });
  }
};
