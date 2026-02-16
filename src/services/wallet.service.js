const Wallet = require('../models/wallet');

/**
 * Automatically initializes a wallet for a newly registered user.
 * Safe to call multiple times (idempotent).
 */
const initializeWalletForUser = async (userId) => {
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
