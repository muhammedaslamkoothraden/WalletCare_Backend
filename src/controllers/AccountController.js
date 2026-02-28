const mongoose = require('mongoose');
const Decimal = require('decimal.js'); 
const Account = require('../models/Account');

/**
 * @description Retrieves balances and calculates global net worth.
 * Supports filtering by ?type=CASH or ?type=BANK
 */
exports.getAccountBalances = async (req, res) => {
  try {
    const { userId } = req.params;
    const { accountId, type } = req.query;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ error: 'Valid UserId is required' });
    }

    const query = { userId, status: { $in: ['ACTIVE', 'FROZEN'] } };
    if (accountId) query._id = accountId;
    if (type && type.toUpperCase() !== 'ALL') query.type = type.toUpperCase();

    const accounts = await Account.find(query);

    if (!accounts || accounts.length === 0) {
      return res.status(200).json({ 
        success: true, 
        accounts: [], 
        globalSummary: { totalAvailable: "0.00", totalReserved: "0.00", netWorth: "0.00" } 
      });
    }

    // 🛡️ THE FIX IS HERE: Bulletproof Parsing
    const formattedAccounts = accounts.map(acc => {
      // Safely grab the balances, default to "0" if missing in DB
      const availableStr = acc.availableBalance ? acc.availableBalance.toString() : "0";
      const reservedStr = acc.reservedBalance ? acc.reservedBalance.toString() : "0";
      
      // Calculate total safely just in case the Mongoose Virtual is missing
      const fallbackTotal = new Decimal(availableStr).plus(new Decimal(reservedStr)).toString();

      return {
        id: acc._id,
        name: acc.name,
        type: acc.type,
        currency: acc.currency || 'INR',
        available: availableStr,
        reserved: reservedStr,
        // Use Virtual if it exists, otherwise use our safe calculation
        total: acc.totalBalance ? acc.totalBalance.toString() : fallbackTotal, 
        isDefault: acc.isDefault,
        status: acc.status
      };
    });

    // Calculate Summary using the safely mapped strings
    let totalAvailable = new Decimal(0);
    let totalReserved = new Decimal(0);
    let netWorth = new Decimal(0);

    formattedAccounts.forEach(acc => {
      totalAvailable = totalAvailable.plus(new Decimal(acc.available));
      totalReserved = totalReserved.plus(new Decimal(acc.reserved));
      netWorth = netWorth.plus(new Decimal(acc.total));
    });

    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      accounts: formattedAccounts,
      globalSummary: {
        totalAvailable: totalAvailable.toFixed(2),
        totalReserved: totalReserved.toFixed(2),
        netWorth: netWorth.toFixed(2)
      }
    });

  } catch (error) {
    // If it crashes now, you will see exactly why in your Node.js terminal
    console.error('FETCH_BALANCES_ERROR:', error);
    return res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
};

/**
 * @description Creates a new account.
 */
exports.createAccount = async (req, res) => {
  try {
    const { userId, name, type } = req.body;

    const allowedTypes = ['CASH', 'BANK'];
    if (!type || !allowedTypes.includes(type.toUpperCase())) {
      return res.status(400).json({ error: 'Invalid type. Must be CASH or BANK' });
    }

    const existingAccounts = await Account.countDocuments({ userId, status: { $ne: 'CLOSED' } });
    
    // Logic: First account is default, or any new CASH account becomes the default
    const isDefault = existingAccounts === 0 || type.toUpperCase() === 'CASH';

    if (isDefault) {
      await Account.updateMany({ userId }, { isDefault: false });
    }

    const newAccount = new Account({
      userId,
      name: name || (type.toUpperCase() === 'CASH' ? 'Main Cash' : 'New Bank'),
      type: type.toUpperCase(),
      isDefault: isDefault,
      status: 'ACTIVE' 
    });

    await newAccount.save();

    return res.status(201).json({
      success: true,
      data: {
        id: newAccount._id,
        name: newAccount.name,
        type: newAccount.type,
        isDefault: newAccount.isDefault,
        status: newAccount.status,
        availableBalance: newAccount.availableBalance.toString(),
        totalBalance: newAccount.totalBalance 
      }
    });

  } catch (error) {
    console.error('CREATE_ACCOUNT_ERROR:', error);
    res.status(500).json({ error: 'Could not create account' });
  }
};