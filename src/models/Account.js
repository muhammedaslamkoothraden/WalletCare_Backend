'use strict';

const mongoose = require('mongoose');
const Decimal = require('decimal.js');

const IMMUTABLE_FIELDS = new Set(['userId', 'currency']);

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
      set: function (v) {
        this._normalizedName = v.toLowerCase();
        this.markModified('_normalizedName'); 
        return v;
      },
    },
    type: {
      type: String,
      enum: { values: ['CASH', 'BANK'], message: 'Type must be CASH or BANK' },
      required: [true, 'Account type is required'],
      uppercase: true,
    },
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
    minBalance: {
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
    isDefault: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ['ACTIVE', 'FROZEN', 'CLOSED'],
      default: 'ACTIVE',
    },
    deletedAt: { type: Date, default: null },
    lastTransactionAt: { type: Date, default: null },
    lastReconciledAt: { type: Date, default: null },
    reconciliationStatus: {
      type: String,
      enum: ['OK', 'MISMATCH'],
      default: 'OK',
    },
    mismatchAmount: {
      type: mongoose.Schema.Types.Decimal128,
      default: null,
      get: (v) => (v ? v.toString() : null),
    },
    _normalizedName: { type: String, select: false },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true, getters: true },
    toObject: { virtuals: true, getters: true },
    optimisticConcurrency: true,
  }
);

AccountSchema.index({ userId: 1, _normalizedName: 1 }, { unique: true });
AccountSchema.index(
  { userId: 1, isDefault: 1 },
  { unique: true, partialFilterExpression: { isDefault: true } }
);

AccountSchema.virtual('totalBalance').get(function () {
  const avail = new Decimal(this.availableBalance || '0');
  const resv = new Decimal(this.reservedBalance || '0');
  return avail.plus(resv).toFixed(2);
});

// ─── Pre-save middleware ──────────────────────────────────────────────────────
AccountSchema.pre('save', async function () {
  if (!this.isNew) {
    for (const field of IMMUTABLE_FIELDS) {
      if (this.isModified(field)) throw new Error(`'${field}' cannot be changed after creation`);
    }
  }

  const available = new Decimal(this.availableBalance?.toString() || '0');
  const reserved = new Decimal(this.reservedBalance?.toString() || '0');
  const balanceChanged = this.isModified('availableBalance') || this.isModified('reservedBalance');

  if (!this.isNew && balanceChanged) {
    if (this.status === 'FROZEN') throw new Error('Balance cannot be changed on a frozen account');
    if (this.status === 'CLOSED') throw new Error('Balance cannot be changed on a closed account');
  }

  if (available.isNegative()) throw new Error('Available balance cannot be negative');
  if (reserved.isNegative()) throw new Error('Reserved balance cannot be negative');

  if (this.isModified('status') && this.status === 'CLOSED') {
    if (!available.equals(0) || !reserved.equals(0)) {
      throw new Error('Account can only be closed if both balances are exactly 0.00');
    }
    if (!this.deletedAt) this.deletedAt = new Date();
  }

  if (this.reconciliationStatus === 'MISMATCH' && !this.mismatchAmount) {
    throw new Error('mismatchAmount is required when reconciliationStatus is MISMATCH');
  }
  if (this.reconciliationStatus === 'OK' && this.mismatchAmount) {
    this.mismatchAmount = null;
  }

  if (balanceChanged) this.lastTransactionAt = new Date();
});

// ─── Pre-update middleware ────────────────────────────────────────────────────
AccountSchema.pre(['updateOne', 'findOneAndUpdate', 'updateMany'], async function () {
  const update = this.getUpdate() || {};
  const filter = this.getFilter();
  const options = this.getOptions();
  const targeted = new Set();

  if (!Object.keys(update).some(k => k.startsWith('$'))) {
    Object.keys(update).forEach(field => targeted.add(field));
  } else {
    for (const [op, payload] of Object.entries(update)) {
      if (op.startsWith('$') && payload && typeof payload === 'object') {
        Object.keys(payload).forEach(field => targeted.add(field));
      }
    }
  }

  for (const field of IMMUTABLE_FIELDS) {
    if (targeted.has(field)) throw new Error(`'${field}' cannot be modified`);
  }

  const session = options?.session ?? undefined;
  const doc = await this.model.findOne(filter).lean().session(session);
  if (!doc) return;

  const isBalanceModified = targeted.has('availableBalance') || targeted.has('reservedBalance');

  if (isBalanceModified) {
    if (doc.status === 'FROZEN') throw new Error('Balance cannot be changed on a frozen account');
    if (doc.status === 'CLOSED') throw new Error('Balance cannot be changed on a closed account');
  }

  let futureAvailable = new Decimal(doc.availableBalance?.toString() || '0');
  if (update.$set?.availableBalance !== undefined) futureAvailable = new Decimal(update.$set.availableBalance.toString());
  else if (update.$inc?.availableBalance !== undefined) futureAvailable = futureAvailable.plus(update.$inc.availableBalance.toString());

  let futureReserved = new Decimal(doc.reservedBalance?.toString() || '0');
  if (update.$set?.reservedBalance !== undefined) futureReserved = new Decimal(update.$set.reservedBalance.toString());
  else if (update.$inc?.reservedBalance !== undefined) futureReserved = futureReserved.plus(update.$inc.reservedBalance.toString());

  if (futureAvailable.isNegative()) throw new Error('Transaction declined: Available balance cannot be negative');
  if (futureReserved.isNegative()) throw new Error('Reserved balance cannot be negative');

  const futureStatus = targeted.has('status') ? (update.$set?.status ?? update.status ?? doc.status) : doc.status;

  if (futureStatus === 'CLOSED' && (!futureAvailable.equals(0) || !futureReserved.equals(0))) {
    throw new Error('Account can only be closed if both balances are exactly 0.00');
  }

  if (isBalanceModified && !options.isReconciliation) {
    this.getUpdate().$set = this.getUpdate().$set || {};
    this.getUpdate().$set.lastTransactionAt = new Date();
  }
});

module.exports = mongoose.models.Account || mongoose.model('Account', AccountSchema);