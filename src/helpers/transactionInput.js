'use strict';

const Decimal = require('decimal.js');
const { assertString } = require('./sanitize');

function sanitizeCategory(category) {
  return assertString(category, 'category', { maxLength: 50 });
}

function sanitizeOptionalDescription(description) {
  return assertString(description, 'description', {
    required: false,
    maxLength: 255,
  });
}

function sanitizeOptionalPartyName(partyName) {
  return assertString(partyName, 'partyName', {
    required: false,
    maxLength: 100,
  });
}

/**
 * Parses and validates a monetary amount:
 * - must be > 0
 * - must have <= 2 decimal places
 *
 * Throws with the same user-facing messages used across controllers/services.
 */
function parseAmount(amount) {
  try {
    const safeAmount = new Decimal(amount.toString());
    if (safeAmount.lessThanOrEqualTo(0)) throw new Error('non-positive');
    if (safeAmount.decimalPlaces() > 2) throw new Error('precision');
    return safeAmount;
  } catch (e) {
    if (e.message === 'precision') {
      throw new Error('Amount cannot have more than 2 decimal places');
    }
    throw new Error('Amount must be a valid number greater than 0');
  }
}

module.exports = {
  sanitizeCategory,
  sanitizeOptionalDescription,
  sanitizeOptionalPartyName,
  parseAmount,
};

