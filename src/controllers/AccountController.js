'use strict';

const mongoose = require('mongoose');
const Decimal  = require('decimal.js');
const Account  = require('../models/Account');

const VALID_ACCOUNT_TYPES = Object.freeze(new Set(['CASH', 'BANK']));

function errRes(res, status, message) {
  return res.status(status).json({ success: false, error: message });
}

// ─── getAccountBalances ───────────────────────────────────────────────────────

exports.getAccountBalances = async (req, res) => {
  try {
    const userId            = req.user.id;
    const { accountId, type } = req.query;

    const query = { userId, status: { $ne: 'CLOSED' } };

    if (accountId) {
      if (!mongoose.Types.ObjectId.isValid(accountId)) {
        return errRes(res, 400, 'Invalid accountId');
      }
      query._id = accountId;
    }

    if (type && type.toUpperCase() !== 'ALL') {
      const cleanType = type.toUpperCase();
      if (!VALID_ACCOUNT_TYPES.has(cleanType)) {
        return errRes(res, 400, `Invalid account type: ${type}. Must be CASH, BANK, or ALL`);
      }
      query.type = cleanType;
    }

    const accounts = await Account.find(query).lean();

    if (!accounts.length) {
      return res.status(200).json({
        success:       true,
        globalSummary: { totalAvailable: '0.00', totalReserved: '0.00', netWorth: '0.00' },
        accounts:      [],
      });
    }

    const totals = { available: new Decimal(0), reserved: new Decimal(0) };

    const formatted = accounts.map((acc) => {
      let avail, resv;
      try {
        avail = new Decimal(acc.availableBalance?.toString() || '0');
        resv  = new Decimal(acc.reservedBalance?.toString()  || '0');
        if (avail.isNegative()) avail = new Decimal(0);
        if (resv.isNegative())  resv  = new Decimal(0);
      } catch {
        avail = new Decimal(0);
        resv  = new Decimal(0);
      }

      totals.available = totals.available.plus(avail);
      totals.reserved  = totals.reserved.plus(resv);

      return {
        id:        acc._id,
        name:      acc.name,
        type:      acc.type,
        currency:  acc.currency,
        available: avail.toFixed(2),
        reserved:  resv.toFixed(2),
        total:     avail.plus(resv).toFixed(2),
        isDefault: acc.isDefault,
        status:    acc.status,
      };
    });

    return res.status(200).json({
      success:       true,
      globalSummary: {
        totalAvailable: totals.available.toFixed(2),
        totalReserved:  totals.reserved.toFixed(2),
        netWorth:       totals.available.plus(totals.reserved).toFixed(2),
      },
      accounts: formatted,
    });
  } catch (error) {
    return errRes(res, 500, 'Failed to fetch balances');
  }
};

// ─── createAccount ────────────────────────────────────────────────────────────

exports.createAccount = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const userId         = req.user.id;
    const { name, type } = req.body;
    const cleanType      = type?.toUpperCase();

    if (!VALID_ACCOUNT_TYPES.has(cleanType)) {
      await session.abortTransaction();
      return errRes(res, 400, 'Type must be CASH or BANK');
    }

    const cleanName = name?.trim();

    // Reject empty string explicitly — trim() turns '   ' into ''
    // which would pass a simple !name check but is not a valid account name.
    if (!cleanName) {
      await session.abortTransaction();
      return errRes(res, 400, 'Account name is required');
    }

    if (cleanName.length > 32) {
      await session.abortTransaction();
      return errRes(res, 400, 'Account name cannot exceed 32 characters');
    }

    const existingCount = await Account.countDocuments(
      { userId, status: { $ne: 'CLOSED' } },
      { session }
    );
    const isDefault = existingCount === 0;

    if (isDefault) {
      await Account.updateMany({ userId }, { isDefault: false }, { session });
    }

    const [newAccount] = await Account.create(
      [{ userId, name: cleanName, type: cleanType, isDefault }],
      { session }
    );

    await session.commitTransaction();
    return res.status(201).json({ success: true, data: newAccount });
  } catch (error) {
    await session.abortTransaction();

    if (error.code === 11000) {
      // Two distinct duplicate key scenarios share the same error code:
      // 1. { userId, _normalizedName } — user already has an account with this name.
      // 2. { userId, isDefault: true } — concurrent request already set a default.
      const isNameConflict    = error.message?.includes('_normalizedName');
      const isDefaultConflict = error.message?.includes('isDefault');

      if (isNameConflict)    return errRes(res, 409, 'An account with this name already exists');
      if (isDefaultConflict) return errRes(res, 409, 'A default account was already created — please retry');

      return errRes(res, 409, 'Duplicate account entry');
    }

    return errRes(res, 500, 'Account creation failed');
  } finally {
    session.endSession();
  }
};

// ─── setAccountAsDefault ──────────────────────────────────────────────────────

exports.setAccountAsDefault = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const userId        = req.user.id;
    const { accountId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(accountId)) {
      await session.abortTransaction();
      return errRes(res, 400, 'Invalid accountId');
    }

    const target = await Account.findOne(
      { _id: accountId, userId, status: { $ne: 'CLOSED' } },
      null,
      { session }
    );

    if (!target) {
      await session.abortTransaction();
      return errRes(res, 404, 'Account not found');
    }

    if (target.isDefault) {
      await session.abortTransaction();
      return res.status(200).json({ success: true, message: 'Account is already the default' });
    }

    await Account.updateMany({ userId }, { isDefault: false }, { session });
    await Account.updateOne(
      { _id: accountId, userId },
      { isDefault: true },
      { session }
    );

    await session.commitTransaction();
    return res.status(200).json({ success: true, message: 'Default account updated' });
  } catch (error) {
    await session.abortTransaction();

    // Partial unique index on { userId, isDefault: true } blocks a second
    // concurrent request from setting a different account as default
    // simultaneously — surface as a clear conflict rather than a 500.
    if (error.code === 11000) {
      return errRes(res, 409, 'Another account was set as default simultaneously — please retry');
    }

    return errRes(res, 500, 'Failed to update default account');
  } finally {
    session.endSession();
  }
};