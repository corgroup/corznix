// NEW module (Wave 5 — CREATE_NEW, see docs/MIGRATION.md §18/§29). No
// address schema/logic existed anywhere in this project (target or
// source) to reuse/adapt — this is genuinely new, minimal, scoped exactly
// to what Account (this wave) and Checkout (Wave 6) need.
import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';

export class AddressRepository {
  async create({
    id = randomUUID(), customerId, type = 'SHIPPING', firstName, lastName, phone,
    addressLine1, addressLine2 = null, city, district = null, state, postalCode, country = 'IN', isDefault = false,
  }) {
    await query(
      `INSERT INTO addresses (id, customer_id, type, first_name, last_name, phone, address_line1, address_line2, city, district, state, postal_code, country, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [id, customerId, type, firstName, lastName, phone, addressLine1, addressLine2, city, district, state, postalCode, country, isDefault ? 1 : 0]
    );
    return this.findById(id);
  }

  async findById(id) {
    const rows = await query('SELECT * FROM addresses WHERE id = ? LIMIT 1', [id]);
    return rows[0] || null;
  }

  async findForCustomer(customerId) {
    return query('SELECT * FROM addresses WHERE customer_id = ? ORDER BY is_default DESC, updated_at DESC', [customerId]);
  }

  async update(id, updates) {
    const entries = Object.entries(updates).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return this.findById(id);
    const sets = entries.map(([key]) => `${key} = ?`).join(', ');
    const values = entries.map(([, value]) => value);
    values.push(id);
    await query(`UPDATE addresses SET ${sets}, updated_at = NOW() WHERE id = ?`, values);
    return this.findById(id);
  }

  async delete(id) {
    await query('DELETE FROM addresses WHERE id = ?', [id]);
  }

  async clearDefaultForCustomer(connection, customerId) {
    await connection.execute('UPDATE addresses SET is_default = 0, updated_at = NOW() WHERE customer_id = ? AND is_default = 1', [customerId]);
  }

  async setDefault(connection, id) {
    await connection.execute('UPDATE addresses SET is_default = 1, updated_at = NOW() WHERE id = ?', [id]);
  }

  async countForCustomer(customerId) {
    const rows = await query('SELECT COUNT(*) AS c FROM addresses WHERE customer_id = ?', [customerId]);
    return Number(rows[0].c);
  }
}
