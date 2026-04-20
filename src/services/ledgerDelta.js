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
  return { balanceChange: amount.negated(), reservedChange: zero };

case 'GOAL_DEALLOCATION':
  return { balanceChange: amount, reservedChange: zero };

case 'RESERVED_IN':
  return { balanceChange: amount.negated(), reservedChange: amount };

case 'RESERVED_OUT':
  return { balanceChange: amount, reservedChange: amount.negated() };
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