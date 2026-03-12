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

    const query = { userId, status: { $in: ['ACTIVE', 'FROZEN'] } };
    if (accountId) query._id = accountId;
    
    if (type && type.toUpperCase() !== 'ALL') {
      query.type = new RegExp(`^${type.trim()}$`, 'i'); 
    }

    const accounts = await Account.find(query);

    let totals = {
      available: new Decimal(0),
      reserved: new Decimal(0),
      netWorth: new Decimal(0)
    };

    const formattedAccounts = accounts.map(acc => {
      const avail = new Decimal(acc.availableBalance?.toString() || "0");
      const resv = new Decimal(acc.reservedBalance?.toString() || "0");
      const accountTotal = avail.plus(resv);

      totals.available = totals.available.plus(avail);
      totals.reserved = totals.reserved.plus(resv);
      totals.netWorth = totals.netWorth.plus(accountTotal);

      return {
        id: acc._id,
        name: acc.name,
        type: acc.type,
        currency: acc.currency,
        available: avail.toFixed(2),
        reserved: resv.toFixed(2),
        total: accountTotal.toFixed(2),
        isDefault: acc.isDefault,
        status: acc.status
      };
    });

    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      accounts: formattedAccounts,
      globalSummary: {
        totalAvailable: totals.available.toFixed(2),
        totalReserved: totals.reserved.toFixed(2),
        netWorth: totals.netWorth.toFixed(2)
      }
    });

  } catch (error) {
    console.error('FETCH_BALANCES_ERROR:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

/**
 * @description Creates a new account with smart default logic.
 */
exports.createAccount = async (req, res) => {
  try {
    const { userId, name, type } = req.body;
    const cleanType = type?.toUpperCase();

    if (!['CASH', 'BANK'].includes(cleanType)) {
      return res.status(400).json({ error: 'Invalid type. Must be CASH or BANK' });
    }

    const existingCount = await Account.countDocuments({ userId, status: { $ne: 'CLOSED' } });
    const isDefault = existingCount === 0 || cleanType === 'CASH';

    if (isDefault) {
      await Account.updateMany({ userId }, { isDefault: false });
    }

    const newAccount = await Account.create({
      userId,
      name: name || (cleanType === 'CASH' ? 'Main Cash' : 'New Bank'),
      type: cleanType,
      isDefault,
      status: 'ACTIVE'
    });

    return res.status(201).json({ success: true, data: newAccount });

  } catch (error) {
    console.error('CREATE_ACCOUNT_ERROR:', error);
    res.status(500).json({ error: 'Could not create account' });
  }
};

/**
 * @description Sets one account as primary and unsets all others.
 */
exports.setAccountAsDefault = async (req, res) => {
  try {
    const { accountId } = req.params;
    const userId = req.user?.id || req.body.userId; // Ensure userId is available

    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    // 1. Reset all user's accounts to isDefault: false
    await Account.updateMany({ userId }, { isDefault: false });

    // 2. Set chosen account to true (Security: check both ID and Owner)
    const updated = await Account.findOneAndUpdate(
      { _id: accountId, userId }, 
      { isDefault: true },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ error: "Account not found or access denied" });
    }

    res.status(200).json({ success: true, message: "Primary account updated" });
  } catch (error) {
    console.error('SET_DEFAULT_ERROR:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};