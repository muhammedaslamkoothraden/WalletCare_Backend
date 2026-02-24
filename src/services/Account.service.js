const Account = require("../models/Account");

/**
 * @description Initializes the default Cash account for a new user.
 * @param {ObjectId} userId - The ID of the newly created user.
 * @param {ClientSession} session - The active Mongoose transaction session.
 */
const initializeAccountForUser = async (userId, session) => {
  // Check if an account already exists for this user (Safety check)
  const existing = await Account.findOne({ userId }).session(session);
  if (existing) return existing;

  // Use an array for .create() when using a session
  const [defaultAccount] = await Account.create([
    {
      userId,
      name: 'Cash',
      type: 'CASH',
      isDefault: true,
      availableBalance: "0.00",
      totalBalance: "0.00",
      currency: 'INR'
    }
  ], { session });

  return defaultAccount;
};

module.exports = { initializeAccountForUser };