const Account = require("../models/Account");
const mongoose = require("mongoose");

/**
 * @description Automatically creates the default 'Cash' account for a new user.
 * Must be called within a session to ensure transactional integrity.
 * * @param {mongoose.Types.ObjectId} userId - The ID of the newly created user
 * @param {mongoose.ClientSession} session - The active MongoDB transaction session
 */
exports.initializeAccountForUser = async (userId, session) => {
  try {
    // 1. Check if a default Cash account already exists for this user
    // This prevents "Duplicate Key" errors during re-testing
    const existingAccount = await Account.findOne({ 
      userId, 
      name: "Cash" 
    }).session(session);

    if (existingAccount) {
      console.log(`Account already exists for user: ${userId}`);
      return existingAccount;
    }

    // 2. Define the default wallet structure
    const defaultAccount = new Account({
      userId: userId,
      name: "Cash",
      type: "CASH",
      isDefault: true,
      currency: "INR",
      // Using explicit Decimal128 casting for financial precision
      availableBalance: mongoose.Types.Decimal128.fromString("0.00"),
      reservedBalance: mongoose.Types.Decimal128.fromString("0.00"),
      totalBalance: mongoose.Types.Decimal128.fromString("0.00")
    });

    // 3. Save the account within the provided session
    // If the controller's transaction fails, this save will be rolled back
    await defaultAccount.save({ session });
    
    console.log(`Successfully initialized Cash account for user: ${userId}`);
    return defaultAccount;

  } catch (error) {
    // We log the detailed error here for debugging
    console.error("--- ACCOUNT SERVICE ERROR ---");
    console.error("User ID:", userId);
    console.error("Mongoose Error:", error.message);
    
    // We throw the ORIGINAL error so the controller catch block 
    // knows exactly why the transaction failed.
    throw error;
  }
};