'use strict';

const mongoose = require('mongoose');
const Decimal = require('decimal.js');
const Account = require('../models/Account');
const Ledger = require('../models/Ledger');
const { assertString, StringValidationError } = require('../helpers/sanitize');
const { resolveMinBalance } = require('../helpers/balanceUtils');

const VALID_ACCOUNT_TYPES = Object.freeze(new Set(['CASH', 'BANK']));

function errRes(res, status, message) {
  return res.status(status).json({ success: false, error: message });
}

// ─── getAccountBalances ───────────────────────────────────────────────────────
exports.getAccountBalances = async (req, res) => {
  try {
    const userId = req.user.id;
    const { accountId, type } = req.query;

    const query = { userId, status: { $ne: 'CLOSED' } };

    if (accountId) {
      if (!mongoose.Types.ObjectId.isValid(accountId)) return errRes(res, 400, 'Invalid accountId');
      query._id = accountId;
    }

    if (type && type.toUpperCase() !== 'ALL') {
      const cleanType = type.toUpperCase();
      if (!VALID_ACCOUNT_TYPES.has(cleanType)) return errRes(res, 400, `Invalid type: ${type}`);
      query.type = cleanType;
    }

    const accounts = await Account.find(query).lean();

    if (!accounts.length) {
      return res.status(200).json({
        success: true,
        globalSummary: { totalAvailable: '0.00', totalReserved: '0.00', netWorth: '0.00' },
        accounts: [],
      });
    }

    const totals = { available: new Decimal(0), reserved: new Decimal(0) };

    const formatted = accounts.map((acc) => {
      let avail, resv;
      try {
        avail = new Decimal(acc.availableBalance?.toString() || '0');
        resv = new Decimal(acc.reservedBalance?.toString() || '0');
      } catch {
        avail = new Decimal(0);
        resv = new Decimal(0);
      }

      totals.available = totals.available.plus(avail);
      totals.reserved = totals.reserved.plus(resv);

      return {
        id: acc._id,
        name: acc.name,
        type: acc.type,
        currency: acc.currency,
        minBalance: acc.minBalance?.toString() || '0.00',
        available: avail.toFixed(2),
        reserved: resv.toFixed(2),
        total: avail.plus(resv).toFixed(2),
        isDefault: acc.isDefault,
        status: acc.status,
      };
    });

    return res.status(200).json({
      success: true,
      globalSummary: {
        totalAvailable: totals.available.toFixed(2),
        totalReserved: totals.reserved.toFixed(2),
        netWorth: totals.available.plus(totals.reserved).toFixed(2),
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
    const userId = req.user.id;
    const { name, type, minBalance, initialDeposit } = req.body;

    // Fix #6: validate type early with a clean 400 response
    const cleanType = type?.toUpperCase();
    if (!VALID_ACCOUNT_TYPES.has(cleanType)) {
      await session.abortTransaction();
      return errRes(res, 400, 'Invalid account type. Must be CASH or BANK');
    }

    // Fix #7: sanitize name consistently with updateAccount
    let validatedName;
    try {
      validatedName = assertString(name, 'Account name', { maxLength: 32 });
    } catch (err) {
      await session.abortTransaction();
      return errRes(res, 400, err.message);
    }

    // Fix #5: use resolveMinBalance instead of raw fallback
    let resolvedMin;
    try {
      resolvedMin = resolveMinBalance(minBalance, cleanType);
    } catch (err) {
      await session.abortTransaction();
      return errRes(res, 400, err.message);
    }

    const depositAmount = new Decimal(initialDeposit || '0');

    // 1. Create the Account with a 0.00 balance
    const [newAccount] = await Account.create(
      [{
        userId,
        name: validatedName,
        type: cleanType,
        minBalance: resolvedMin,
        availableBalance: '0.00',
      }],
      { session }
    );

    // 2. Create the Ledger Entry for the initial deposit
    if (depositAmount.greaterThan(0)) {
      await Ledger.create([{
        userId,
        accountId: newAccount._id,
        transactionType: 'INCOME',
        direction: 'STANDARD',
        category: 'Initial Deposit',
        amount: depositAmount.toFixed(2),
        description: `Account Opening Deposit`,
        status: 'COMPLETED',
        idempotencyKey: `init-dep-${newAccount._id}`,
        transactedAt: new Date(),
      }], { session });

      // 3. Update the Account balance to reflect the deposit
      newAccount.availableBalance = depositAmount.toFixed(2);
      await newAccount.save({ session });
    }

    await session.commitTransaction();
    return res.status(201).json({ success: true, data: newAccount });

  } catch (error) {
    await session.abortTransaction();
    if (error.code === 11000 && error.message.includes('_normalizedName')) {
      return errRes(res, 409, 'An account with this name already exists');
    }
    return errRes(res, 500, 'Failed to create account');
  } finally {
    session.endSession();
  }
};
exports.setAccountAsDefault = async (req, res) => {
  const session = await mongoose.startSession();
  
  try {
    session.startTransaction();
    const userId = req.user.id;
    const { accountId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(accountId)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, error: 'Invalid accountId' });
    }

    // 1. Verify the account exists, belongs to the user, and isn't closed
    const target = await Account.findOne({ 
      _id: accountId, 
      userId: userId, 
      status: { $ne: 'CLOSED' } 
    }).session(session);

    if (!target) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, error: 'Account not found' });
    }

    if (target.isDefault) {
      await session.abortTransaction();
      return res.status(200).json({ success: true, message: 'Account is already default' });
    }

    // 2. Bypass Mongoose Middleware using native collection updates for pure speed and safety
    // This unsets isDefault for all other accounts belonging to this user
    await Account.collection.updateMany(
      { userId: new mongoose.Types.ObjectId(userId), _id: { $ne: new mongoose.Types.ObjectId(accountId) } },
      { $set: { isDefault: false } },
      { session }
    );

    // 3. Set the target account to default (bypassing .save() to avoid version errors)
    await Account.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(accountId) },
      { $set: { isDefault: true } },
      { session }
    );

    await session.commitTransaction();
    return res.status(200).json({ success: true, message: 'Default account updated' });

  } catch (error) {
    await session.abortTransaction();
    console.error("Set Default Error:", error);

    if (error.code === 11000) {
        return res.status(409).json({ success: false, error: 'Concurrent request conflict — please retry' });
    }
    
    return res.status(500).json({ success: false, error: 'Failed to update default account' });
  } finally {
    session.endSession();
  }
};
// ─── deleteAccount ────────────────────────────────────────────────────────────
exports.deleteAccount = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const userId = req.user.id;
    const { accountId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(accountId)) {
      await session.abortTransaction();
      return errRes(res, 400, 'Invalid accountId');
    }

    // Notice we removed the status check here, just in case you want to allow 
    // permanently deleting an already "CLOSED" account as well.
    const account = await Account.findOne({ _id: accountId, userId }).session(session);

    if (!account) {
      await session.abortTransaction();
      return errRes(res, 404, 'Account not found');
    }

    const available = new Decimal(account.availableBalance?.toString() || '0');
    const reserved = new Decimal(account.reservedBalance?.toString() || '0');

    if (!available.equals(0) || !reserved.equals(0)) {
      await session.abortTransaction();
      return errRes(res, 400, 'Cannot delete account with non-zero balance. Clear funds and debts first.');
    }

    const wasDefault = account.isDefault;

    // ─── HARD DELETE THE ACCOUNT ───
    await account.deleteOne({ session });

    // Optional: If you also want to permanently delete all transactions tied to this account
    // to prevent orphaned data in your database, uncomment the line below:
    // await Transaction.deleteMany({ accountId: account._id }).session(session);

    // Reassign the default account if the deleted one was the default
    if (wasDefault) {
      const nextActive = await Account.findOne({ userId, status: { $ne: 'CLOSED' } }).session(session);
      if (nextActive) {
        nextActive.isDefault = true;
        await nextActive.save({ session });
      }
    }

    await session.commitTransaction();
    return res.status(200).json({ success: true, message: 'Account permanently deleted' });
  } catch (error) {
    await session.abortTransaction();
    console.error("Delete Account Error:", error);
    return errRes(res, 500, 'Failed to delete account');
  } finally {
    session.endSession();
  }
};

// ─── updateAccount ────────────────────────────────────────────────────────────
exports.updateAccount = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const userId = req.user.id;
    const { accountId } = req.params;
    const { name, type, minBalance } = req.body;

    if (!mongoose.Types.ObjectId.isValid(accountId)) {
      await session.abortTransaction();
      return errRes(res, 400, 'Invalid accountId');
    }

    const account = await Account.findOne({
      _id: accountId,
      userId,
      status: { $ne: 'CLOSED' },
    }).session(session);

    if (!account) {
      await session.abortTransaction();
      return errRes(res, 404, 'Account not found or is closed');
    }

    if (name) {
      try {
        account.name = assertString(name, 'Account name', { maxLength: 32 });
      } catch (err) {
        await session.abortTransaction();
        return errRes(res, 400, err.message);
      }
    }

    // type is intentionally mutable (not in IMMUTABLE_FIELDS)
    if (type) {
      const cleanType = type.toUpperCase();
      if (!VALID_ACCOUNT_TYPES.has(cleanType)) {
        await session.abortTransaction();
        return errRes(res, 400, 'Invalid account type. Must be CASH or BANK');
      }
      account.type = cleanType;
    }

    if (minBalance !== undefined) {
      try {
        const parsedMin = new Decimal(minBalance);
        if (parsedMin.isNaN()) throw new Error();
        account.minBalance = parsedMin.toFixed(2);
      } catch {
        await session.abortTransaction();
        return errRes(res, 400, 'Invalid minimum balance format');
      }
    }

    await account.save({ session });

    await session.commitTransaction();
    return res.status(200).json({
      success: true,
      message: 'Account updated successfully',
      data: account,
    });

  } catch (error) {
    await session.abortTransaction();

    // 🛑 1. Print the REAL error to your Node.js terminal
    console.error("🚨 REAL BACKEND ERROR:", error);

    if (error.code === 11000 && error.message.includes('_normalizedName')) {
      return errRes(res, 409, 'An account with this name already exists');
    }

    // 🛑 2. Temporarily send the real error message to the Flutter app!
    return errRes(res, 500, error.message || 'Failed to update account');
    
  } finally {
    session.endSession();
  }
};
