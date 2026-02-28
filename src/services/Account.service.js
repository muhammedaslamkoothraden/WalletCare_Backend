const Account = require("../models/Account");

/**
 * @description Automatically creates the default 'Cash' account for a new user.
 * Must be called within a session to ensure transactional integrity.
 * @param {mongoose.Types.ObjectId} userId - The ID of the newly created user
 * @param {mongoose.ClientSession} session - The active MongoDB transaction session
 */
exports.initializeAccountForUser = async (userId, session) => {
  try {
    // 1. Idempotency Check
    const existingAccount = await Account.findOne({ 
      userId, 
      name: "Cash" 
    }).session(session);

    if (existingAccount) {
      console.log(`Account already exists for user: ${userId}`);
      return existingAccount;
    }

    // 2. Define the default wallet
    // Notice how lean this is? The Schema defaults handle the zero-balances,
    // and the pre('save') middleware automatically calculates totalBalance!
    const defaultAccount = new Account({
      userId: userId,
      name: "Cash",
      type: "CASH",
      isDefault: true,
      currency: "INR" 
      // status: 'ACTIVE' is automatically applied by the schema default
    });

    // 3. Save and trigger the Guardian middleware
    await defaultAccount.save({ session });
    
    console.log(`Successfully initialized Cash account for user: ${userId}`);
    return defaultAccount;

  } catch (error) {
    console.error(`--- ACCOUNT INIT ERROR [User: ${userId}] ---`);
    console.error("Mongoose Error:", error.message);
    throw error; // Let the Auth Controller handle the rollback
  }
};