'use strict';

const mongoose = require('mongoose');
const Account  = require('../models/Account');

exports.initializeAccountForUser = async (userId, session) => {
  try {
    // Guard — catch malformed userId before any DB call
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      throw new Error('Invalid userId passed to initializeAccountForUser');
    }

    // Idempotency check — uses _normalizedName to match the unique index
    const existingAccount = await Account.findOne({
      userId,
      _normalizedName: 'cash',
    }).session(session);

    if (existingAccount) return existingAccount;

    const defaultAccount = new Account({
      userId,
      name:      'Cash',
      type:      'CASH',
      isDefault: true,
      currency:  'INR',
    });

    await defaultAccount.save({ session });
    return defaultAccount;

  } catch (error) {
    throw error; // Auth controller owns the session rollback
  }
};