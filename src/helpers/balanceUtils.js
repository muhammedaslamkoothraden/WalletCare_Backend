'use strict';

const Decimal = require('decimal.js');

// System-wide default minimum balances
const DEFAULT_MIN_BALANCES = Object.freeze({
  CASH: '0.00',
  BANK: '0.00', // Standard neo-bank 'no overdraft' baseline
});

/**
 * Resolves the minimum balance for a new account.
 * Prioritizes user input, falls back to system defaults based on account type.
 * * @param {string|number} userProvidedMin - The minBalance from req.body
 * @param {string} accountType - The validated account type ('CASH' or 'BANK')
 * @returns {string} The validated minimum balance formatted to 2 decimal places
 * @throws {Error} If the provided minimum balance is not a valid number
 */
function resolveMinBalance(userProvidedMin, accountType) {
  if (userProvidedMin !== undefined && userProvidedMin !== null) {
    try {
      const parsed = new Decimal(userProvidedMin);
      if (parsed.isNaN()) throw new Error('NaN');
      return parsed.toFixed(2);
    } catch (error) {
      throw new Error('Invalid minimum balance format. Must be a valid number.');
    }
  }

  const fallback = DEFAULT_MIN_BALANCES[accountType] || '0.00';
  return new Decimal(fallback).toFixed(2);
}

module.exports = {
  resolveMinBalance
};