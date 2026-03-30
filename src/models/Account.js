'use strict';

const mongoose = require('mongoose');
const Decimal = require('decimal.js');

// ─── Immutable Fields ─────────────────────────────────────────────────────────
// These define the account's identity and must never change after creation.
// Changing userId would reassign the account to a different user.
// Changing currency or type would invalidate all historical balance entries.
const IMMUTABLE_FIELDS = new Set(['userId', 'currency', 'type']);

// ─── Schema ───────────────────────────────────────────────────────────────────
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

    // ⚠️ SYSTEM CONTRACT:
    // Account balances are DERIVED (cached) values.
    // The Ledger collection is the single source of truth.
    // Any inconsistency must be resolved via the reconciliation service.
    //
    // NOTE: Mongoose getters (v.toString()) apply when reading via JS (doc.availableBalance).
    // They do NOT apply inside MongoDB aggregation pipelines.
    // In aggregation always wrap with: { $toDouble: '$availableBalance' }
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

    // ─── Soft delete ──────────────────────────────────────────────────────────
    // Closed accounts are not physically deleted — they are archived.
    // Use deletedAt to filter them out in queries: { deletedAt: null }
    deletedAt: {
      type: Date,
      default: null,
    },

    // ─── Reconciliation & Tracking ───────────────────────────────────────────
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
    // Populated when reconciliationStatus = 'MISMATCH'.
    // Stores the difference between cached balance and ledger-derived balance.
    // NOTE: A zero mismatch (Decimal128('0')) is semantically different from
    // null (no reconciliation run yet). The getter correctly returns '0' for
    // zero and null for unset — do not conflate these two states.
    mismatchAmount: {
      type: mongoose.Schema.Types.Decimal128,
      default: null,
      get: (v) => (v ? v.toString() : null),
    },

    // Normalised lowercase name for case-insensitive uniqueness checks.
    // ⚠️ SEEDING WARNING: This field is only populated via pre('save') middleware.
    // Documents created via insertMany(), bulkWrite(), or direct MongoDB writes
    // (e.g. seeding scripts) will NOT have this field set, silently breaking the
    // uniqueness guarantee on { userId, _normalizedName }.
    // Always use .save() or the Account service layer to create accounts.
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

// Unique account name per user (case-insensitive via _normalizedName)
AccountSchema.index({ userId: 1, _normalizedName: 1 }, { unique: true });

// Only one default account allowed per user
AccountSchema.index(
  { userId: 1, isDefault: 1 },
  { unique: true, partialFilterExpression: { isDefault: true } }
);

// ─── Virtuals ─────────────────────────────────────────────────────────────────

// NOTE: Because toJSON/toObject have getters:true, this.availableBalance and
// this.reservedBalance arrive here as strings (getter already applied).
// new Decimal(string) handles this correctly — no raw Decimal128 object is seen.
AccountSchema.virtual('totalBalance').get(function () {
  const avail = new Decimal(this.availableBalance || '0');
  const resv  = new Decimal(this.reservedBalance  || '0');
  return avail.plus(resv).toFixed(2);
});

// ─── Pre-save middleware ──────────────────────────────────────────────────────
// FIX: Reordered guards so balance validation fires before status guards.
// Previously a frozen account with a negative balance would throw the
// frozen error instead of the more accurate "cannot be negative" error.
//
// FIX: Decimal instances computed once at the top and reused everywhere —
// previously they were instantiated twice (closure rule + balance check).

AccountSchema.pre('save', async function () {

  // ── 1. Immutability ───────────────────────────────────────────────────────
  if (!this.isNew) {
    for (const field of IMMUTABLE_FIELDS) {
      if (this.isModified(field)) {
        throw new Error(`'${field}' cannot be changed after account creation`);
      }
    }
  }

  // ── 2. Compute balances once — reused by all checks below ────────────────
  const available = new Decimal(this.availableBalance?.toString() || '0');
  const reserved  = new Decimal(this.reservedBalance?.toString()  || '0');
  const balanceChanged =
    this.isModified('availableBalance') || this.isModified('reservedBalance');

  // ── 3. Balance floor — must run BEFORE status guards ─────────────────────
  // If a frozen account also has a negative balance, the client should
  // know the balance is invalid — not just that the account is frozen.
  if (available.isNegative()) throw new Error('Available balance cannot be negative');
  if (reserved.isNegative())  throw new Error('Reserved balance cannot be negative');

  // ── 4. Status guards — block balance changes on inactive accounts ─────────
  if (!this.isNew && balanceChanged) {
    if (this.status === 'FROZEN') throw new Error('Balance cannot be changed on a frozen account');
    if (this.status === 'CLOSED') throw new Error('Balance cannot be changed on a closed account');
  }

  // ── 5. Zero-balance closure rule ─────────────────────────────────────────
  if (this.isModified('status') && this.status === 'CLOSED') {
    if (!available.equals(0) || !reserved.equals(0)) {
      throw new Error('Account can only be closed if both available and reserved balances are exactly 0.00');
    }
    // Mark soft-delete timestamp when account is closed
    if (!this.deletedAt) {
      this.deletedAt = new Date();
    }
  }

  // ── 6. Track last transaction time ───────────────────────────────────────
  if (balanceChanged) {
    this.lastTransactionAt = new Date();
  }

  // ── 7. Normalised name ────────────────────────────────────────────────────
  if (this.isNew || this.isModified('name')) {
    this._normalizedName = this.name.toLowerCase();
  }
});

// ─── Pre-update middleware ────────────────────────────────────────────────────
// FIX: Replaced model.find(filter) with findOne(filter).lean() to avoid N+1.
// Previously, a broad filter like { userId } would load every account for
// that user just to validate a single updateOne — O(n) reads under load.
//
// FIX: futureStatus now uses ?? instead of || to correctly fall back to
// doc.status when neither $set.status nor update.status is present.
// Using || would treat an empty string as falsy and resolve incorrectly.
//
// FIX: session is now passed as `options?.session ?? undefined` instead of
// options.session directly. Passing null explicitly to .session() in some
// Mongoose versions clears the session rather than being a no-op.

AccountSchema.pre(['updateOne', 'findOneAndUpdate', 'updateMany'], async function () {
  const update  = this.getUpdate() || {};
  const filter  = this.getFilter();
  const options = this.getOptions();

  // Collect all field names being targeted by this update
  const targeted = new Set();

  if (!Object.keys(update).some(k => k.startsWith('$'))) {
    Object.keys(update).forEach(field => targeted.add(field));
  } else {
    for (const [op, payload] of Object.entries(update)) {
      if (op.startsWith('$') && payload && typeof payload === 'object') {
        for (const field of Object.keys(payload)) {
          targeted.add(field);
        }
      }
    }
  }

  // ── Immutability ──────────────────────────────────────────────────────────
  for (const field of IMMUTABLE_FIELDS) {
    if (targeted.has(field)) {
      throw new Error(`'${field}' cannot be modified after account creation`);
    }
  }

  // ── FIX: Pass session as undefined (not null) to avoid unintended session clearing ──
  const session = options?.session ?? undefined;

  const doc = await this.model
    .findOne(filter)
    .lean()
    .session(session);

  // No matching document — nothing to validate
  if (!doc) return;

  const isBalanceModified = targeted.has('availableBalance') || targeted.has('reservedBalance');

  // ── Status guards ─────────────────────────────────────────────────────────
  if (isBalanceModified) {
    if (doc.status === 'FROZEN') throw new Error('Balance cannot be changed on a frozen account');
    if (doc.status === 'CLOSED') throw new Error('Balance cannot be changed on a closed account');
  }

  // ── Compute future balances ───────────────────────────────────────────────
  let futureAvailable = new Decimal(doc.availableBalance?.toString() || '0');
  if (update.$set?.availableBalance !== undefined) {
    futureAvailable = new Decimal(update.$set.availableBalance.toString());
  } else if (update.$inc?.availableBalance !== undefined) {
    futureAvailable = futureAvailable.plus(update.$inc.availableBalance.toString());
  } else if (update.availableBalance !== undefined) {
    futureAvailable = new Decimal(update.availableBalance.toString());
  }

  let futureReserved = new Decimal(doc.reservedBalance?.toString() || '0');
  if (update.$set?.reservedBalance !== undefined) {
    futureReserved = new Decimal(update.$set.reservedBalance.toString());
  } else if (update.$inc?.reservedBalance !== undefined) {
    futureReserved = futureReserved.plus(update.$inc.reservedBalance.toString());
  } else if (update.reservedBalance !== undefined) {
    futureReserved = new Decimal(update.reservedBalance.toString());
  }

  // ── Balance floor ─────────────────────────────────────────────────────────
  if (futureAvailable.isNegative()) throw new Error('Available balance cannot be negative');
  if (futureReserved.isNegative())  throw new Error('Reserved balance cannot be negative');

  // ── FIX: futureStatus uses ?? so undefined falls back to doc.status ───────
  // Using || would incorrectly treat a falsy (but valid) status as missing.
  const futureStatus = targeted.has('status')
    ? (update.$set?.status ?? update.status ?? doc.status)
    : doc.status;

  // ── Zero-balance closure rule ─────────────────────────────────────────────
  if (futureStatus === 'CLOSED' && (!futureAvailable.equals(0) || !futureReserved.equals(0))) {
    throw new Error('Account can only be closed if both available and reserved balances are exactly 0.00');
  }

  // ── Track last transaction time (skip for silent reconciliation writes) ───
  if (isBalanceModified && !options.isReconciliation) {
    this.getUpdate().$set = this.getUpdate().$set || {};
    this.getUpdate().$set.lastTransactionAt = new Date();
  }
});

// ─── Model ────────────────────────────────────────────────────────────────────

module.exports = mongoose.models.Account || mongoose.model('Account', AccountSchema);