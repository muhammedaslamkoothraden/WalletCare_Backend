'use strict';

const Decimal = require('decimal.js');

function invertDelta({ balanceChange, reservedChange }) {
  return {
    balanceChange: balanceChange.negated(),
    reservedChange: reservedChange.negated(),
  };
}

/**
 * Computes how a COMPLETED ledger entry changes cached balances.
 *
 * @param {string} direction
 * @param {string} transactionType
 * @param {any} rawAmount - positive amount (String, Number, or Decimal128)
 * @returns {{ balanceChange: Decimal, reservedChange: Decimal }}
 */
function computeBalanceDelta(direction, transactionType, rawAmount) {
  // 🎯 THE FIX: Force the raw input into a safe decimal.js instance
  const amount = new Decimal(rawAmount.toString());
  const zero = new Decimal(0);

  switch (direction) {
    case 'STANDARD':
    case 'EDIT_REPLACEMENT': {
      return {
        // Now .negated() will work perfectly!
        balanceChange: transactionType === 'INCOME' ? amount : amount.negated(),
        reservedChange: zero,
      };
    }

    case 'GOAL_ALLOCATION':
    case 'RESERVED_IN': // 🎯 ADDED: Moving funds FROM Available TO Reserved
      return { balanceChange: amount.negated(), reservedChange: amount };

    case 'GOAL_DEALLOCATION':
    case 'RESERVED_OUT': // 🎯 ADDED: Moving funds FROM Reserved TO Available
      return { balanceChange: amount, reservedChange: amount.negated() };

    case 'GOAL_COMPLETION':
      return { balanceChange: zero, reservedChange: amount.negated() };

    case 'ACCOUNT_TRANSFER_OUT':
      return { balanceChange: amount.negated(), reservedChange: zero };

    case 'ACCOUNT_TRANSFER_IN':
      return { balanceChange: amount, reservedChange: zero };

    default:
      throw new Error(`Unrecognized direction in computeBalanceDelta: '${direction}'`);
  }
}

function computeForwardDelta(direction, transactionType, amount) {
  return computeBalanceDelta(direction, transactionType, amount);
}

function computeUndoDelta(direction, transactionType, amount) {
  return invertDelta(computeBalanceDelta(direction, transactionType, amount));
}

function computeReversalDelta(parentDirection, parentTransactionType, amount) {
  // A reversal entry negates what the parent entry did.
  return computeUndoDelta(parentDirection, parentTransactionType, amount);
}

module.exports = {
  computeBalanceDelta,
  computeForwardDelta,
  computeUndoDelta,
  computeReversalDelta,
};