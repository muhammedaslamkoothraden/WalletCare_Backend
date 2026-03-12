const mongoose = require('mongoose');
const Decimal = require('decimal.js');
const Account = require('../models/Account');

/**
 * @desc    Fetch user balances and global summary
 * @route   GET /api/v1/accounts/:userId
 */
exports.getAccountBalances = async (req, res) => {
  try {
    const { userId } = req.params;
    const { accountId, type } = req.query;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ success: false, error: 'Valid UserId is required' });
    }

    const query = { userId, status: { $ne: 'CLOSED' } };
    if (accountId) query._id = accountId;
    
    if (type && type.toUpperCase() !== 'ALL') {
      query.type = type.toUpperCase();
    }

    const accounts = await Account.find(query).lean();

    const totals = {
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
      globalSummary: {
        totalAvailable: totals.available.toFixed(2),
        totalReserved: totals.reserved.toFixed(2),
        netWorth: totals.netWorth.toFixed(2)
      },
      accounts: formattedAccounts
    });

  } catch (error) {
    console.error('FETCH_BALANCES_ERROR:', error.message);
    return res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
};

/**
 * @desc    Create a new wallet/account
 * @route   POST /api/v1/accounts
 */
exports.createAccount = async (req, res) => {
  try {
    const { userId, name, type } = req.body;
    const cleanType = type?.toUpperCase();

    if (!['CASH', 'BANK'].includes(cleanType)) {
      return res.status(400).json({ success: false, error: 'Type must be CASH or BANK' });
    }

    const existingCount = await Account.countDocuments({ userId, status: { $ne: 'CLOSED' } });
    
    // First account is default, or any account explicitly named/typed as primary logic
    const isDefault = existingCount === 0;

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
    console.error('CREATE_ACCOUNT_ERROR:', error.message);
    return res.status(500).json({ success: false, error: 'Account creation failed' });
  }
};

/**
 * @desc    Set primary account for the user
 * @route   PATCH /api/v1/accounts/:accountId/default
 */
exports.setAccountAsDefault = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { accountId } = req.params;
    const userId = req.user?.id || req.body.userId;

    if (!userId) {
      return res.status(401).json({ success: false, error: "Authentication required" });
    }

    await Account.updateMany({ userId }, { isDefault: false }).session(session);

    const updated = await Account.findOneAndUpdate(
      { _id: accountId, userId }, 
      { isDefault: true },
      { new: true, session }
    );

    if (!updated) {
      throw new Error("Account not found or access denied");
    }

    await session.commitTransaction();
    res.status(200).json({ success: true, message: "Primary account updated" });

  } catch (error) {
    await session.abortTransaction();
    console.error('SET_DEFAULT_ERROR:', error.message);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    session.endSession();
  }
};