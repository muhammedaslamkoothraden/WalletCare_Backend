const mongoose = require('mongoose');
const Account = require('../models/Account');

/**
 * @description Retrieves balances for all user accounts and calculates a global net worth.
 * Supports single account lookup via query param ?accountId=...
 */
exports.getAccountBalances = async (req, res) => {
  try {
    const { userId } = req.params;
    const { accountId } = req.query;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ error: 'Valid UserId is required' });
    }

    // 1. Define Query
    const query = { userId, isActive: true };
    if (accountId) query._id = accountId;

    // 2. Execute Fetch
    const accounts = await Account.find(query).lean();

    if (!accounts || accounts.length === 0) {
      return res.status(404).json({ error: 'No active accounts found' });
    }

    // 3. Transform Data for Frontend (Flutter optimized)
    const formattedAccounts = accounts.map(acc => {
      // Ensure we treat Decimal128 as strings for precision
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
        total: total, // Calculated by your Schema Middleware
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
      globalSummary
    });

  } catch (error) {
    console.error('FETCH_BALANCES_ERROR:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * @description Creates a new account. 
 * Enforces types: 'CASH' or 'BANK'.
 * Handles 'isDefault' logic for Cash accounts.
 */
exports.createAccount = async (req, res) => {
  try {
    const { userId, name, type, initialBalance = 0 } = req.body;

    // 1. Strict Type Validation
    const allowedTypes = ['CASH', 'BANK'];
    if (!allowedTypes.includes(type.toUpperCase())) {
      return res.status(400).json({ error: 'Invalid type. Must be CASH or BANK' });
    }

    // 2. Default Logic
    // If it's the first account or specifically named 'Cash', make it default
    const existingAccounts = await Account.countDocuments({ userId });
    const isDefault = existingAccounts === 0 || type.toUpperCase() === 'CASH';

    // 3. If this is a new default, remove default status from previous accounts
    if (isDefault) {
      await Account.updateMany({ userId }, { isDefault: false });
    }

    // 4. Create the Account
    const newAccount = new Account({
      userId,
      name: name || (type === 'CASH' ? 'Main Cash' : 'New Bank'),
      type: type.toUpperCase(),
      availableBalance: mongoose.Types.Decimal128.fromString(initialBalance.toString()),
      isDefault: isDefault,
      isActive: true
    });

    await newAccount.save();

    return res.status(201).json({
      success: true,
      data: {
        id: newAccount._id,
        name: newAccount.name,
        type: newAccount.type,
        isDefault: newAccount.isDefault,
        balance: newAccount.availableBalance.toString()
      }
    });

  } catch (error) {
    console.error('CREATE_ACCOUNT_ERROR:', error);
    res.status(500).json({ error: 'Could not create account' });
  }
};