'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const Decimal = require('decimal.js');
const Ledger = require('../models/ledger');
const Account = require('../models/Account');

// ─── Custom Error Class ───────────────────────────────────────────────────────

class TransferError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'TransferError';
    this.statusCode = statusCode;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toDecimal128(decimalValue) {
  return mongoose.Types.Decimal128.fromString(decimalValue.toFixed(2));
}

// FIX: Derive the transfer-in idempotency key from a SHA-256 hash of the
// out-key rather than using a ':linked' suffix convention.
//
// The ':linked' suffix was a collision risk — a client sending
// idempotencyKey = "abc123:linked" as a normal transaction would collide
// with the in-leg of a transfer whose out-key was "abc123".
//
// The hash-based approach is:
//   1. Deterministic — same out-key always produces the same in-key.
//   2. Non-guessable — clients cannot accidentally collide with it.
//   3. Length-safe — truncated to 64 hex chars, within the 128-char limit.
function deriveInboundKey(outboundKey) {
  return crypto
    .createHash('sha256')
    .update(`transfer-in-leg:${outboundKey}`)
    .digest('hex')
    .slice(0, 64);
}

function _duplicateTransferResponse(outEntry, inEntry, fromAccount, toAccount) {
  return {
    duplicate: true,
    fromTxid: outEntry?._id ?? null,
    toTxid: inEntry?._id ?? null,
    from: {
      accountId: outEntry?.accountId ?? null,
      availableBalance: fromAccount?.availableBalance?.toString() ?? '0.00',
      reservedBalance: fromAccount?.reservedBalance?.toString() ?? '0.00',
    },
    to: {
      accountId: inEntry?.accountId ?? null,
      availableBalance: toAccount?.availableBalance?.toString() ?? '0.00',
      reservedBalance: toAccount?.reservedBalance?.toString() ?? '0.00',
    },
  };
}

// ─── Core Service Logic ───────────────────────────────────────────────────────

async function initiateTransfer({
  userId, fromAccountId, toAccountId,
  safeAmount, category, idempotencyKey, description,
}) {
  const MAX_RETRIES = 3;

  // FIX: Derive the in-leg key once, outside the retry loop.
  // It is purely deterministic so recomputing it per attempt is wasteful,
  // and having it declared here makes the relationship explicit.
  const inboundKey = deriveInboundKey(idempotencyKey);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {

      // ── 1. Idempotency check ─────────────────────────────────────────────
      const existingOut = await Ledger
        .findOne({ userId, idempotencyKey })
        .session(session)
        .lean();

      if (existingOut) {
        const existingIn = await Ledger
          .findOne({ userId, idempotencyKey: inboundKey })
          .session(session)
          .lean();

        // FIX: Use transferGroupId to detect a half-written transfer.
        // If the OUT leg exists but the IN leg is missing, the previous
        // attempt's session commit failed after staging the OUT write.
        // MongoDB's atomic session commit should prevent this in practice,
        // but we surface it explicitly rather than returning a false
        // duplicate-success response.
        if (existingOut && !existingIn) {
          await session.abortTransaction();
          throw new TransferError(
            'Transfer is in an inconsistent state — out leg exists but in leg is missing. ' +
            'Please contact support with transferGroupId: ' + existingOut.transferGroupId,
            500
          );
        }

        const [fromAccount, toAccount] = await Promise.all([
          Account.findOne({ _id: existingOut.accountId, userId }).session(session).lean(),
          Account.findOne({ _id: existingIn.accountId, userId }).session(session).lean(),
        ]);

        await session.abortTransaction();
        return _duplicateTransferResponse(existingOut, existingIn, fromAccount, toAccount);
      }

      // ── 2. Fetch both accounts in parallel ───────────────────────────────
      const [fromAccount, toAccount] = await Promise.all([
        Account.findOne({ _id: fromAccountId, userId }).session(session),
        Account.findOne({ _id: toAccountId, userId }).session(session),
      ]);

      if (!fromAccount) { await session.abortTransaction(); throw new TransferError('Source account not found', 404); }
      if (!toAccount) { await session.abortTransaction(); throw new TransferError('Destination account not found', 404); }

      // ── 3. Status guards ─────────────────────────────────────────────────
      if (fromAccount.status === 'CLOSED') { await session.abortTransaction(); throw new TransferError('Source account is closed', 400); }
      if (fromAccount.status === 'FROZEN') { await session.abortTransaction(); throw new TransferError('Source account is frozen', 400); }

      // Policy: transfers INTO a frozen account are also blocked.
      // In some systems you can receive into a frozen account — if that
      // changes, remove only the toAccount frozen guard below.
      if (toAccount.status === 'CLOSED') { await session.abortTransaction(); throw new TransferError('Destination account is closed', 400); }
      if (toAccount.status === 'FROZEN') { await session.abortTransaction(); throw new TransferError('Destination account is frozen', 400); }

      if (fromAccount.currency !== toAccount.currency) {
        await session.abortTransaction();
        throw new TransferError(
          `Currency mismatch: source is ${fromAccount.currency}, destination is ${toAccount.currency}.`,
          400
        );
      }

      // ── 4. Balance computation ───────────────────────────────────────────
      // FIX: Use Decimal.js throughout — do not mix raw Decimal128 objects
      // with Decimal.js arithmetic. Previously fromReserved/toReserved were
      // treated as already-normalized decimals in some code paths, which led
      // to inconsistent precision handling.
      const fromAvailable = new Decimal(fromAccount.availableBalance.toString());
      const fromReserved = new Decimal(fromAccount.reservedBalance.toString());
      const toAvailable = new Decimal(toAccount.availableBalance.toString());
      const toReserved = new Decimal(toAccount.reservedBalance.toString());

      const newFromAvailable = fromAvailable.minus(safeAmount);
      const newToAvailable = toAvailable.plus(safeAmount);

      if (newFromAvailable.isNegative()) {
        await session.abortTransaction();
        throw new TransferError('Insufficient available balance in source account', 400);
      }

      // ── 5. Generate a shared transferGroupId for both legs ───────────────
      // FIX: Set transferGroupId on both ledger entries.
      // This field was modeled in the schema but never populated.
      // It allows the idempotency recovery path above to detect a half-written
      // transfer and surface it as an error rather than a false duplicate-success.
      const transferGroupId = new mongoose.Types.ObjectId();

      // ── 6. Build and write ledger entries ────────────────────────────────
      const outEntry = new Ledger({
        userId,
        accountId: fromAccount._id,
        amount: toDecimal128(safeAmount),
        transactionType: 'TRANSFER',
        direction: 'ACCOUNT_TRANSFER_OUT',
        category,
        description,
        idempotencyKey,                          // original client key — OUT leg
        linkedAccountId: toAccount._id,
        parentTransactionId: null,
        status: 'COMPLETED',
        transferGroupId,                         // ← shared between both legs
      });

      const inEntry = new Ledger({
        userId,
        accountId: toAccount._id,
        amount: toDecimal128(safeAmount),
        transactionType: 'TRANSFER',
        direction: 'ACCOUNT_TRANSFER_IN',
        category,
        description,
        idempotencyKey: inboundKey,          // FIX: hash-derived, not ':linked' suffix
        linkedAccountId: fromAccount._id,
        parentTransactionId: null,
        status: 'COMPLETED',
        transferGroupId,                          // ← same group as OUT leg
      });

      await outEntry.save({ session });
      await inEntry.save({ session });

      // ── 7. Update cached balances ────────────────────────────────────────
      fromAccount.availableBalance = toDecimal128(newFromAvailable);
      toAccount.availableBalance = toDecimal128(newToAvailable);

      // Anti-deadlock: always acquire document locks in a consistent order
      // so two concurrent opposite transfers (A→B and B→A) cannot deadlock.
      const accountsToSave = [fromAccount, toAccount].sort((a, b) =>
        a._id.toString().localeCompare(b._id.toString())
      );

      for (const account of accountsToSave) {
        await account.save({ session });
      }

      await session.commitTransaction();

      return {
        duplicate: false,
        transferGroupId,
        fromTxid: outEntry._id,
        toTxid: inEntry._id,
        from: {
          accountId: fromAccount._id,
          availableBalance: newFromAvailable.toFixed(2),
          reservedBalance: fromReserved.toFixed(2),
        },
        to: {
          accountId: toAccount._id,
          availableBalance: newToAvailable.toFixed(2),
          reservedBalance: toReserved.toFixed(2),
        },
      };

    } catch (error) {
      if (session.inTransaction()) {
        await session.abortTransaction().catch(() => { });
      }

      // ── Race condition recovery ──────────────────────────────────────────
      const isVersionError = error.name === 'VersionError';
      const isWriteConflict = error.code === 112 || error.hasErrorLabel?.('TransientTransactionError');

      if ((isVersionError || isWriteConflict) && attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, Math.random() * 50 * attempt));
        continue;
      }

      // ── Idempotency collision on concurrent write ────────────────────────
      if (error.code === 11000) {
        try {
          const [winOut, winIn] = await Promise.all([
            Ledger.findOne({ userId, idempotencyKey }).lean(),
            Ledger.findOne({ userId, idempotencyKey: inboundKey }).lean(),
          ]);
          if (winOut) {
            const [fromAccount, toAccount] = await Promise.all([
              Account.findOne({ _id: winOut.accountId, userId }).lean(),
              winIn ? Account.findOne({ _id: winIn.accountId, userId }).lean() : Promise.resolve(null),
            ]);
            return _duplicateTransferResponse(winOut, winIn, fromAccount, toAccount);
          }
        } catch (_) { }

        throw new TransferError('Idempotency key collision during retry', 409);
      }

      // Bubble up TransferError or exhausted-retry errors to the controller.
      throw error;

    } finally {
      session.endSession();
    }
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { initiateTransfer, TransferError };