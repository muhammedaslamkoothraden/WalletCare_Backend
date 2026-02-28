const mongoose = require('mongoose');
const Decimal = require('decimal.js'); // Required for safe Net Worth math
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

    // FIX 1: Use the updated 'status' enum instead of 'isActive'
    // You might want to include FROZEN accounts in net worth, but definitely not CLOSED ones.
    const query = { userId, status: { $in: ['ACTIVE', 'FROZEN'] } };
    if (accountId) query._id = accountId;

    const accounts = await Account.find(query).lean();

    if (!accounts || accounts.length === 0) {
      return res.status(200).json({ 
        success: true, 
        accounts: [], 
        globalSummary: { totalAvailable: "0.00", totalReserved: "0.00", netWorth: "0.00" } 
      });
    }

    // 3. Transform Data for Frontend
    const formattedAccounts = accounts.map(acc => {
      return {
        id: acc._id,
        name: acc.name,
        type: acc.type,
        currency: acc.currency,
        available: acc.availableBalance.toString(),
        reserved: acc.reservedBalance.toString(),
        total: acc.totalBalance.toString(),
        isDefault: acc.isDefault,
        status: acc.status
      };
    });

    // FIX 2: Safely Calculate Global Summary using Decimal.js
    let totalAvailable = new Decimal(0);
    let totalReserved = new Decimal(0);
    let netWorth = new Decimal(0);

    formattedAccounts.forEach(acc => {
      totalAvailable = totalAvailable.plus(acc.available);
      totalReserved = totalReserved.plus(acc.reserved);
      netWorth = netWorth.plus(acc.total);
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
    console.error('FETCH_BALANCES_ERROR:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * @description Creates a new account. 
 * Enforces types: 'CASH' or 'BANK'.
 * All accounts start at 0.00. Use Ledger for opening balances.
 */
exports.createAccount = async (req, res) => {
  try {
    // FIX 3: Removed initialBalance. Accounts must strictly start at zero.
    const { userId, name, type } = req.body;

    // 1. Strict Type Validation
    const allowedTypes = ['CASH', 'BANK'];
    if (!allowedTypes.includes(type.toUpperCase())) {
      return res.status(400).json({ error: 'Invalid type. Must be CASH or BANK' });
    }

    // 2. Default Logic
    const existingAccounts = await Account.countDocuments({ userId, status: { $ne: 'CLOSED' } });
    const isDefault = existingAccounts === 0 || type.toUpperCase() === 'CASH';

    // 3. If this is a new default, remove default status from previous accounts
    if (isDefault) {
      await Account.updateMany({ userId }, { isDefault: false });
    }

    // 4. Create the Account (Schema defaults automatically handle the 0.00 balances)
    const newAccount = new Account({
      userId,
      name: name || (type === 'CASH' ? 'Main Cash' : 'New Bank'),
      type: type.toUpperCase(),
      isDefault: isDefault,
      status: 'ACTIVE' // FIX 1: Updated to match schema
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
        balance: newAccount.availableBalance.toString()
      }
    });

  } catch (error) {
    console.error('CREATE_ACCOUNT_ERROR:', error);
    res.status(500).json({ error: 'Could not create account' });
  }
};