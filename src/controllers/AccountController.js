const mongoose = require('mongoose');
const Decimal = require('decimal.js'); 
const Account = require('../models/Account');

exports.getAccountBalances = async (req, res) => {
  try {
    const userId = req.user._id; // changed from req.params to JWT user
    const { accountId } = req.query;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ error: 'Valid UserId is required' });
    }

    // FIX: Prevent Mongoose CastError if frontend sends a bad accountId
    if (accountId && !mongoose.Types.ObjectId.isValid(accountId)) {
      return res.status(400).json({ error: 'Invalid AccountId format' });
    }

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

    const formattedAccounts = accounts.map(acc => {
      const avail = acc.availableBalance.toString();
      const reserved = acc.reservedBalance.toString();
      const total = acc.totalBalance.toString();

      return {
        id: acc._id,
        name: acc.name,
        type: acc.type,
        currency: acc.currency,
        available: avail,
        reserved: reserved,
        total: total,
        isDefault: acc.isDefault
      };
    });

    // 4. Calculate Global Summary (Total Net Worth across all accounts)
    const globalSummary = formattedAccounts.reduce((summary, acc) => {
      return {
        totalAvailable: (parseFloat(summary.totalAvailable) + parseFloat(acc.available)).toFixed(2),
        totalReserved: (parseFloat(summary.totalReserved) + parseFloat(acc.reserved)).toFixed(2),
        netWorth: (parseFloat(summary.netWorth) + parseFloat(acc.total)).toFixed(2)
      };
    }, { totalAvailable: 0, totalReserved: 0, netWorth: 0 });

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
    console.error('FETCH_BALANCES_ERROR:', error);
    return res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
};


/**
 * @description Creates a new account. 
 * Enforces types: 'CASH' or 'BANK'.
 * Handles 'isDefault' logic for Cash accounts.
 */
exports.createAccount = async (req, res) => {
  try {
    const { name, type, initialBalance = 0 } = req.body;
    const userId = req.user._id; // changed from req.body to JWT user

    // 1. Strict Type Validation
    const allowedTypes = ['CASH', 'BANK'];
    
    if (!type || !allowedTypes.includes(type.toUpperCase())) {
      return res.status(400).json({ error: 'Invalid type. Must be CASH or BANK' });
    }

    // 2. Default Logic
    const existingAccounts = await Account.countDocuments({ userId });
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
        // FIX: Match the exact mapping keys expected by the frontend AccountModel
        available: newAccount.availableBalance.toString(),
        reserved: newAccount.reservedBalance.toString(),
        total: newAccount.totalBalance.toString()
      }
    });

  } catch (error) {
    console.error('CREATE_ACCOUNT_ERROR:', error);
    res.status(500).json({ error: 'Could not create account' });
  }
};