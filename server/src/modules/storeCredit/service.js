import { withTransaction } from '../../database/connection/transaction.js';
import { AppError } from '../../utils/errors.js';
import { storeCreditRepository } from './repository.js';
import { notificationService } from '../notifications/service.js';

const DEFAULT_CURRENCY = 'INR';
const formatMinor = (minor, currency = DEFAULT_CURRENCY) => (currency === 'INR' ? '₹' : `${currency} `)
  + (Number(minor) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 });

/**
 * Canonical "CORCOTTON Credit" ledger service — the single closed-loop
 * store-credit authority (Wave 8F §95/§96). Never a second wallet.
 *
 * Reserved Exchange Credit (§51) is NOT this service — that restricted,
 * exchange-bound value lives with the exchange domain. Only a cheaper-item
 * Different-Style Exchange remainder crosses over here, as one GRANT.
 */
export class StoreCreditService {
  constructor({ repository = storeCreditRepository, transaction = withTransaction } = {}) {
    this.repository = repository;
    this.transaction = transaction;
  }

  entryDto(entry) {
    return {
      // The ledger entry's own id: a refund that credits store credit records
      // it as its reference, the way a gateway refund records the provider's.
      id: entry.id,
      entryType: entry.entry_type,
      amountMinor: Number(entry.amount_minor),
      balanceAfterMinor: Number(entry.balance_after_minor),
      sourceType: entry.source_type,
      sourceId: entry.source_id ?? null,
      reason: entry.reason ?? null,
      createdAt: entry.created_at,
    };
  }

  async getBalanceMinor(customerId, { currency = DEFAULT_CURRENCY, connection = null } = {}) {
    const account = await this.repository.accountByCustomer(connection, customerId, currency);
    return account ? Number(account.balance_minor) : 0;
  }

  async getSummary(customerId, { currency = DEFAULT_CURRENCY, limit = 50, offset = 0 } = {}) {
    const [balanceMinor, history] = await Promise.all([
      this.getBalanceMinor(customerId, { currency }),
      this.repository.history(customerId, { limit, offset }),
    ]);
    return { currency, balanceMinor, entries: history.map((e) => this.entryDto(e)) };
  }

  /**
   * Apply one signed ledger movement. `amountMinor` is signed: +ve grants
   * credit, -ve spends it. Idempotent on `idempotencyKey` — a retried call
   * returns the original entry and moves the balance exactly once (§91/§95).
   *
   * Composes into an outer transaction when `connection` is supplied (the
   * return / exchange resolution path always passes one).
   */
  async applyEntry({
    customerId,
    amountMinor,
    entryType,
    sourceType,
    sourceId = null,
    idempotencyKey,
    reason = null,
    createdByStaffId = null,
    currency = DEFAULT_CURRENCY,
    connection = null,
  }) {
    if (!customerId) throw new AppError('VALIDATION_ERROR', 'A customer is required.', 400);
    if (!Number.isInteger(amountMinor) || amountMinor === 0) {
      throw new AppError('VALIDATION_ERROR', 'Store-credit amount must be a non-zero integer (minor units).', 400);
    }
    if (!['GRANT', 'DEBIT', 'EXPIRE', 'ADJUST', 'REVERSAL'].includes(entryType)) {
      throw new AppError('VALIDATION_ERROR', `Unknown store-credit entry type "${entryType}".`, 400);
    }
    if (!sourceType) throw new AppError('VALIDATION_ERROR', 'A store-credit source type is required.', 400);
    if (!idempotencyKey || String(idempotencyKey).length > 160) {
      throw new AppError('VALIDATION_ERROR', 'A valid store-credit idempotency key is required.', 400);
    }
    const signMatches = (entryType === 'GRANT' && amountMinor > 0)
      || (['DEBIT', 'EXPIRE'].includes(entryType) && amountMinor < 0)
      || ['ADJUST', 'REVERSAL'].includes(entryType);
    if (!signMatches) throw new AppError('VALIDATION_ERROR', `Store-credit ${entryType} has the wrong sign.`, 400);

    const run = async (tx) => {
      const replay = await this.repository.entryByIdempotencyKey(tx, idempotencyKey);
      if (replay) {
        if (Number(replay.amount_minor) !== amountMinor || replay.customer_id !== customerId) {
          throw new AppError('IDEMPOTENCY_CONFLICT', 'This store-credit key was already used for a different movement.', 409);
        }
        return this.entryDto(replay);
      }
      const account = await this.repository.ensureAccount(tx, customerId, currency);
      const balanceAfter = Number(account.balance_minor) + amountMinor;
      if (balanceAfter < 0) {
        throw new AppError('INSUFFICIENT_STORE_CREDIT', 'This would take the store-credit balance below zero.', 409);
      }
      let entry;
      try {
        entry = await this.repository.insertEntry(tx, {
          accountId: account.id, customerId, currency, entryType, amountMinor,
          balanceAfterMinor: balanceAfter, sourceType, sourceId, reason, idempotencyKey, createdByStaffId,
        });
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          const raced = await this.repository.entryByIdempotencyKey(tx, idempotencyKey);
          if (raced) return this.entryDto(raced);
        }
        throw err;
      }
      await this.repository.setBalance(tx, account.id, balanceAfter);
      return this.entryDto(entry);
    };

    // Credit the customer can spend is worth telling them about — a
    // cancellation, a refund taken as credit, an exchange remainder. Only real
    // additions (a debit is the customer spending it, and an expiry has its
    // own copy), and only after the ledger has actually moved.
    const notifyIfGranted = async (dto) => {
      if (!['GRANT', 'REVERSAL'].includes(entryType) || amountMinor <= 0) return dto;
      await notificationService.emit('STORE_CREDIT_GRANTED', {
        customerId,
        entryId: dto.id,
        amount: formatMinor(amountMinor, currency),
        balance: formatMinor(dto.balanceAfterMinor, currency),
        reason: reason || 'a recent order',
      }).catch(() => {});
      return dto;
    };

    // The message is sent AFTER the ledger has moved — a notification inside
    // the transaction would announce credit a rollback then took away.
    return notifyIfGranted(await (connection ? run(connection) : this.transaction(run)));
  }
}

export const storeCreditService = new StoreCreditService();
