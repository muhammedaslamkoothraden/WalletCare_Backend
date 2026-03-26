'use strict';

/**
 * Asserts that a value is a non-empty string after trimming.
 * Throws a typed error if the check fails so controllers can
 * catch it and return a 400 without crashing.
 *
 * @param {*}      value      - The raw value from req.body
 * @param {string} fieldName  - Used in the error message
 * @param {{ required?: boolean, maxLength?: number }} [opts]
 */
function assertString(value, fieldName, opts = {}) {
  const { required = true, maxLength = null } = opts;

  // Allow null/undefined only if the field is optional
  if (value === null || value === undefined) {
    if (required) throw new StringValidationError(`${fieldName} is required`);
    return null;
  }

  // The core guard: reject anything that is not a primitive string
  if (typeof value !== 'string') {
    throw new StringValidationError(`${fieldName} must be a string`);
  }

  const trimmed = value.trim();

  if (required && trimmed.length === 0) {
    throw new StringValidationError(`${fieldName} is required`);
  }

  if (maxLength && trimmed.length > maxLength) {
    throw new StringValidationError(
      `${fieldName} cannot exceed ${maxLength} characters`
    );
  }

  // Strip control characters (ASCII 0–31 and 127).
  // These are invisible characters that corrupt stored text and can
  // cause display bugs or log injection attacks if written to a ledger
  // entry that gets printed in logs or shown in a UI.
  return trimmed.replace(/[\x00-\x1F\x7F]/g, '');
}

class StringValidationError extends Error {
  constructor(message) {
    super(message);
    this.name       = 'StringValidationError';
    this.statusCode = 400;
  }
}

module.exports = { assertString, StringValidationError };