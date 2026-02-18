const mongoose = require('mongoose');
const Wallet = require('../models/wallet');

const initializeWalletForUser = async (userId) => {

  if (!userId) {
    throw new Error('userId is required');
  }

  if (!mongoose.Types.ObjectId.isValid(userId)) {
    throw new Error('Invalid userId');
  }

  return Wallet.findOneAndUpdate(
    { userId },
    {
      $setOnInsert: {
        userId,
        availableBalance: 0,
        savingsBalance: 0,
        currency: 'INR'
      }
    },
    {
      new: true,
      upsert: true
    }
  );
};

module.exports = {
  initializeWalletForUser
};
