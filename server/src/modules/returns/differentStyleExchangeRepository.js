import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';

const exec = async (connection, sql, params = []) =>
  (connection ? (await connection.execute(sql, params))[0] : query(sql, params));

// Data access for different-style exchange transactions + reserved exchange
// credits. The credit row is the money authority and is only ever moved under
// a FOR UPDATE lock (§62).
export class DifferentStyleExchangeRepository {
  transactionByRequest(connection, returnRequestId) {
    return exec(connection, 'SELECT * FROM exchange_transactions WHERE return_request_id = ? LIMIT 1', [returnRequestId])
      .then((r) => r[0] || null);
  }

  transactionByContext(connection, token, { lock = false } = {}) {
    return exec(connection,
      `SELECT * FROM exchange_transactions WHERE context_token = ? LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [token])
      .then((r) => r[0] || null);
  }

  transactionById(connection, id, { lock = false } = {}) {
    return exec(connection,
      `SELECT * FROM exchange_transactions WHERE id = ? LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [id])
      .then((r) => r[0] || null);
  }

  creditByTransaction(connection, transactionId, { lock = false } = {}) {
    return exec(connection,
      `SELECT * FROM reserved_exchange_credits WHERE exchange_transaction_id = ? LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
      [transactionId]).then((r) => r[0] || null);
  }

  // brand_id derived from the original order — same reasoning as returns.
  async insertTransaction(connection, t) {
    const id = randomUUID();
    await exec(connection,
      `INSERT INTO exchange_transactions
        (id, brand_id, transaction_number, customer_id, original_order_id, return_request_id, status, currency,
         eligible_value_minor, eligibility_snapshot_json, context_token, expires_at)
       VALUES (?, (SELECT brand_id FROM orders WHERE id = ?), ?, ?, ?, ?, 'RESERVED', ?, ?, ?, ?, ?)`,
      [id, t.originalOrderId, t.transactionNumber, t.customerId, t.originalOrderId, t.returnRequestId, t.currency,
        t.eligibleValueMinor, JSON.stringify(t.eligibilitySnapshot), t.contextToken, t.expiresAt]);
    return exec(connection, 'SELECT * FROM exchange_transactions WHERE id = ?', [id]).then((r) => r[0]);
  }

  async insertCredit(connection, c) {
    const id = randomUUID();
    await exec(connection,
      `INSERT INTO reserved_exchange_credits
        (id, exchange_transaction_id, customer_id, currency, status, amount_minor, expires_at)
       VALUES (?, ?, ?, ?, 'RESERVED', ?, ?)`,
      [id, c.exchangeTransactionId, c.customerId, c.currency, c.amountMinor, c.expiresAt]);
    return exec(connection, 'SELECT * FROM reserved_exchange_credits WHERE id = ?', [id]).then((r) => r[0]);
  }

  updateTransaction(connection, id, fields) {
    const sets = ['updated_at = NOW(3)'];
    const params = [];
    for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = ?`); params.push(v); }
    params.push(id);
    return exec(connection, `UPDATE exchange_transactions SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  /**
   * Terminal credit transition, guarded by the current status + version — the
   * consume/expire race resolver (§62). Returns true only if this caller won.
   */
  async transitionCredit(connection, id, { fromStatus, expectedVersion, toStatus, fields = {} }) {
    const sets = ['status = ?', 'version = version + 1', 'updated_at = NOW(3)'];
    const params = [toStatus];
    for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = ?`); params.push(v); }
    params.push(id, fromStatus, expectedVersion);
    const res = await exec(connection,
      `UPDATE reserved_exchange_credits SET ${sets.join(', ')} WHERE id = ? AND status = ? AND version = ?`, params);
    return res.affectedRows === 1;
  }

  dueForExpiry(limit = 50) {
    return query(
      `SELECT c.*, t.id AS transaction_id, t.return_request_id
         FROM reserved_exchange_credits c
         JOIN exchange_transactions t ON t.id = c.exchange_transaction_id
        WHERE c.status = 'RESERVED' AND c.expires_at <= NOW(3)
        ORDER BY c.expires_at LIMIT ?`, [Number(limit)]);
  }

  ownedTransaction(customerId, id) {
    return query(
      'SELECT * FROM exchange_transactions WHERE customer_id = ? AND (id = ? OR transaction_number = ?) LIMIT 1',
      [customerId, id, id]).then((r) => r[0] || null);
  }
}

export const differentStyleExchangeRepository = new DifferentStyleExchangeRepository();
