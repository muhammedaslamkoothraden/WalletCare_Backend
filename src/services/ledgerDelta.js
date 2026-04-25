'use strict';

const Decimal = require('decimal.js');

// ─── computeBalanceDelta ──────────────────────────────────────────────────────
//
// Returns the { balanceChange, reservedChange } pair for a forward ledger entry.
// Both values are Decimal instances — callers are responsible for applying them
// to the account's current balances.
//
// Direction → transactionType contract is enforced upstream in the controller
// via VALID_DIRECTION_TYPE_COMBINATIONS. This function trusts that contract.

function computeBalanceDelta(direction, transactionType, rawAmount) {
  const amount = new Decimal(rawAmount.toString());
  const zero = new Decimal(0);

  switch (direction) {
    case 'STANDARD':
      return {
        balanceChange: transactionType === 'INCOME' ? amount : amount.negated(),
        reservedChange: zero,
      };

    case 'GOAL_ALLOCATION':
      // Money moves out of the account into the goal envelope.
      return { balanceChange: amount.negated(), reservedChange: zero };

    case 'GOAL_DEALLOCATION':
      // Money is released back from the goal envelope into the account.
      return { balanceChange: amount, reservedChange: zero };

    case 'GOAL_COMPLETION':
      // Goal is fully spent on its intended purpose — treated identically to
      // GOAL_ALLOCATION: money leaves the account (no deallocation back first).
      return { balanceChange: amount.negated(), reservedChange: zero };

    case 'ACCOUNT_TRANSFER_IN':
      return { balanceChange: amount, reservedChange: zero };

    case 'ACCOUNT_TRANSFER_OUT':
      return { balanceChange: amount.negated(), reservedChange: zero };

    case 'RESERVED_IN':
      // Funds move from available → reserved (locked for a future obligation).
      return { balanceChange: amount.negated(), reservedChange: amount };

    case 'RESERVED_OUT':
      // Funds move from reserved → available (obligation fulfilled or cancelled).
      return { balanceChange: amount, reservedChange: amount.negated() };

    default:
      throw new Error(`Unrecognized direction in computeBalanceDelta: '${direction}'`);
  }
}

// ─── computeReversalDelta ─────────────────────────────────────────────────────
//
// Returns the balance delta for a REVERSAL entry that cancels a previously
// COMPLETED ledger entry. The delta is exactly the inverse of what the original
// entry did — computed by calling computeBalanceDelta on the original's direction
// and transactionType, then negating both components.
//
// Parameters describe the *original* (parent) entry, not the reversal entry itself:
//   @param {string} originalDirection        — e.g. 'STANDARD', 'GOAL_ALLOCATION'
//   @param {string} originalTransactionType  — e.g. 'INCOME', 'EXPENSE'
//   @param {string|Decimal} rawAmount        — the original entry's amount
//
// Example: the parent was STANDARD/EXPENSE (debit ₹500).
//   computeBalanceDelta  → balanceChange = -500
//   computeReversalDelta → balanceChange = +500  (money flows back in)

function computeReversalDelta(originalDirection, originalTransactionType, rawAmount) {
  const { balanceChange, reservedChange } = computeBalanceDelta(
    originalDirection,
    originalTransactionType,
    rawAmount
  );

  return {
    balanceChange: balanceChange.negated(),
    reservedChange: reservedChange.negated(),
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { computeBalanceDelta, computeReversalDelta };