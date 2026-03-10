const mongoose = require('mongoose');
const Decimal = require('decimal.js');
const Account = require('../models/Account');

/**
 * @description Retrieves balances and calculates Net Worth on-the-fly.
 */
exports.getAccountBalances = async (req, res) => {
  try {
    const { userId } = req.params;
    const { accountId, type } = req.query;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ error: 'Valid UserId is required' });
    }

    // Filter: Include ACTIVE and FROZEN for Net Worth, exclude CLOSED.
    const query = { userId, status: { $in: ['ACTIVE', 'FROZEN'] } };
    
    if (accountId) query._id = accountId;
    
    if (type && type.toUpperCase() !== 'ALL') {
      const cleanType = type.trim();
      query.type = new RegExp(`^${cleanType}$`, 'i'); 
    }

    const accounts = await Account.find(query);

    if (!accounts || accounts.length === 0) {
      return res.status(200).json({ 
        success: true, 
        accounts:[], 
        globalSummary: { totalAvailable: "0.00", totalReserved: "0.00", netWorth: "0.00" } 
      });
    }

    // 1. Initialize Global Aggregators
    let globalAvailable = new Decimal(0);
    let globalReserved = new Decimal(0);
    let globalNetWorth = new Decimal(0);

    // 2. Transform Data and Calculate
    const formattedAccounts = accounts.map(acc => {
      // FIX: Always use .toString() before passing to Decimal.js to avoid DecimalError
      const avail = new Decimal(acc.availableBalance?.toString() || "0");
      const resv = new Decimal(acc.reservedBalance?.toString() || "0");
      
      // Individual Account Total (Net Worth per account)
      const accountTotal = avail.plus(resv);

      // Add to Global Totals
      globalAvailable = globalAvailable.plus(avail);
      globalReserved = globalReserved.plus(resv);
      globalNetWorth = globalNetWorth.plus(accountTotal);

      return {
        id: acc._id,
        name: acc.name,
        type: acc.type,
        currency: acc.currency,
        available: avail.toFixed(2),
        reserved: resv.toFixed(2),
        total: accountTotal.toFixed(2), // Calculated on the fly
        isDefault: acc.isDefault,
        status: acc.status
      };
    });

    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      accounts: formattedAccounts,
      globalSummary: {
        totalAvailable: globalAvailable.toFixed(2),
        totalReserved: globalReserved.toFixed(2),
        netWorth: globalNetWorth.toFixed(2) // This is your calculated Net Worth
      }
    });

  } catch (error) {
    console.error('FETCH_BALANCES_ERROR:', error);
    return res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
};

/**
 * @description Creates a new account starting at 0.00.
 */
exports.createAccount = async (req, res) => {
  try {
    const { userId, name, type } = req.body;

    const allowedTypes = ['CASH', 'BANK'];
    if (!type || !allowedTypes.includes(type.toUpperCase())) {
      return res.status(400).json({ error: 'Invalid type. Must be CASH or BANK' });
    }

    // Default Logic: First account or any CASH account becomes default
    const existingCount = await Account.countDocuments({ userId, status: { $ne: 'CLOSED' } });
    const isDefault = existingCount === 0 || type.toUpperCase() === 'CASH';

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
        available: "0.00",
        total: "0.00"
      }
    });

  } catch (error) {
    console.error('CREATE_ACCOUNT_ERROR:', error);
    res.status(500).json({ error: 'Could not create account' });
  }
};