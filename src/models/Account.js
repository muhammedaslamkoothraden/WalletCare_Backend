'use strict';

const mongoose = require('mongoose');
const Decimal = require('decimal.js');

// Fields that define the account's identity — must never change after creation.
// Changing userId would reassign the account to a different user.
// Changing currency or type would invalidate all historical balance entries.
const IMMUTABLE_FIELDS = new Set(['userId', 'currency', 'type']);

const AccountSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Account must belong to a user'],
      index: true,
    },
    name: {
      type: String,
      required: [true, 'Account name is required'],
      trim: true,
      maxlength: [32, 'Account name cannot exceed 32 characters'],
    },
    type: {
      type: String,
      enum: { values: ['CASH', 'BANK'], message: 'Type must be CASH or BANK' },
      required: [true, 'Account type is required'],
      uppercase: true,
    },

    // ⚠️ IMPORTANT SYSTEM CONTRACT:
    // Account balances are DERIVED (cached) values.
    // The Ledger collection is the single source of truth.
    // Any inconsistency must be resolved via reconciliation.
    availableBalance: {
      type: mongoose.Schema.Types.Decimal128,
      default: '0.00',
      get: (v) => (v ? v.toString() : '0.00'),
    },
    reservedBalance: {
      type: mongoose.Schema.Types.Decimal128,
      default: '0.00',
      get: (v) => (v ? v.toString() : '0.00'),
    },

    currency: {
      type: String,
      default: 'INR',
      uppercase: true,
      enum: {
        values: ['INR', 'USD', 'EUR', 'GBP', 'AED'],
        message: 'Currency {VALUE} is not supported',
      },
    },
    isDefault: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      enum: ['ACTIVE', 'FROZEN', 'CLOSED'],
      default: 'ACTIVE',
    },

    // ─── Reconciliation & Tracking ──────────────────────────────────────────
    lastTransactionAt: {
      type: Date,
      default: null,
    },
    lastReconciledAt: {
      type: Date,
      default: null,
    },
    reconciliationStatus: {
      type: String,
      enum: ['OK', 'MISMATCH'],
      default: 'OK',
    },

    // Normalised lowercase name for case-insensitive uniqueness checks.
    _normalizedName: {
      type: String,
      select: false,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true, getters: true },
    toObject: { virtuals: true, getters: true },
    optimisticConcurrency: true,
  }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

AccountSchema.index({ userId: 1, _normalizedName: 1 }, { unique: true });
AccountSchema.index(
  { userId: 1, isDefault: 1 },
  { unique: true, partialFilterExpression: { isDefault: true } }
);

// ─── Virtuals ─────────────────────────────────────────────────────────────────

AccountSchema.virtual('totalBalance').get(function () {
  const avail = new Decimal(this.availableBalance || '0');
  const resv = new Decimal(this.reservedBalance || '0');
  return avail.plus(resv).toFixed(2);
});

// ─── Pre-save middleware ──────────────────────────────────────────────────────

AccountSchema.pre('save', async function () {

  // ── Immutability ──────────────────────────────────────────────────────────
  if (!this.isNew) {
    for (const field of IMMUTABLE_FIELDS) {
      if (this.isModified(field)) {
        throw new Error(`'${field}' cannot be changed after account creation`);
      }
    }
  }

  // ── Closed account guard ──────────────────────────────────────────────────
  // Allow metadata updates, block only balance changes
  if (
    !this.isNew &&
    this.status === 'CLOSED' &&
    (this.isModified('availableBalance') || this.isModified('reservedBalance'))
  ) {
    throw new Error('Balance cannot be changed on a closed account');
  }

  // ── Frozen account guard ──────────────────────────────────────────────────
  if (
    !this.isNew &&
    this.status === 'FROZEN' &&
    (this.isModified('availableBalance') || this.isModified('reservedBalance'))
  ) {
    throw new Error('Balance cannot be changed on a frozen account');
  }

  // ── Balance validation ────────────────────────────────────────────────────
  const available = new Decimal(this.availableBalance?.toString() || '0');
  const reserved = new Decimal(this.reservedBalance?.toString() || '0');

  if (available.isNegative()) throw new Error('Available balance cannot be negative');
  if (reserved.isNegative()) throw new Error('Reserved balance cannot be negative');

  // ── Track last transaction time ───────────────────────────────────────────
  if (
    this.isModified('availableBalance') ||
    this.isModified('reservedBalance')
  ) {
    this.lastTransactionAt = new Date();
  }

  // ── Normalised name ───────────────────────────────────────────────────────
  if (this.isNew || this.isModified('name')) {
    this._normalizedName = this.name.toLowerCase();
  }
});

// ─── Model ────────────────────────────────────────────────────────────────────

module.exports = mongoose.models.Account || mongoose.model('Account', AccountSchema);