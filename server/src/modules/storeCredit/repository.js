import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';

const exec = async (connection, sql, params = []) =>
  (connection ? (await connection.execute(sql, params))[0] : query(sql, params));

// Data access for the canonical "CORCOTTON Credit" ledger. The account row is
// the only mutable projection; entries are append-only.
export class StoreCreditRepository {
  accountByCustomer(connection, customerId, currency = 'INR', { lock = false } = {}) {
    return exec(connection,
      `SELECT * FROM store_credit_accounts WHERE customer_id = ? AND currency = ? LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
      [customerId, currency]).then((r) => r[0] || null);
  }

  // Multi-company (DESIGN.md §4.1) — Phase 4. brand_id is derived from the
  // customer's own row (never passed separately) — a store-credit account
  // always belongs to the same company as its customer.
  async ensureAccount(connection, customerId, currency = 'INR') {
    const existing = await this.accountByCustomer(connection, customerId, currency, { lock: true });
    if (existing) return existing;
    const id = randomUUID();
    try {
      await exec(connection,
        `INSERT INTO store_credit_accounts (id, brand_id, customer_id, currency, balance_minor)
         VALUES (?, (SELECT brand_id FROM customers WHERE id = ?), ?, ?, 0)`,
        [id, customerId, customerId, currency]);
    } catch (err) {
      if (err.code !== 'ER_DUP_ENTRY') throw err;
    }
    return this.accountByCustomer(connection, customerId, currency, { lock: true });
  }

  entryByIdempotencyKey(connection, key) {
    return exec(connection, 'SELECT * FROM store_credit_entries WHERE idempotency_key = ? LIMIT 1', [key])
      .then((r) => r[0] || null);
  }

  async insertEntry(connection, entry) {
    const id = randomUUID();
    await exec(connection,
      `INSERT INTO store_credit_entries
        (id, account_id, customer_id, currency, entry_type, amount_minor, balance_after_minor,
         source_type, source_id, reason, idempotency_key, created_by_staff_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, entry.accountId, entry.customerId, entry.currency, entry.entryType, entry.amountMinor,
        entry.balanceAfterMinor, entry.sourceType, entry.sourceId || null, entry.reason || null,
        entry.idempotencyKey, entry.createdByStaffId || null]);
    return exec(connection, 'SELECT * FROM store_credit_entries WHERE id = ?', [id]).then((r) => r[0]);
  }

  setBalance(connection, accountId, balanceMinor) {
    return exec(connection,
      'UPDATE store_credit_accounts SET balance_minor = ?, updated_at = NOW(3) WHERE id = ?',
      [balanceMinor, accountId]);
  }

  history(customerId, { limit = 50, offset = 0 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    return query(
      `SELECT entry_type, amount_minor, balance_after_minor, source_type, source_id, reason, created_at
         FROM store_credit_entries WHERE customer_id = ?
        ORDER BY created_at DESC, entry_seq DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`,
      [customerId]);
  }
}

export const storeCreditRepository = new StoreCreditRepository();
