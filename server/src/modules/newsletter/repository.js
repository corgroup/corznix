import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';
import { resolveBrandId } from '../../utils/defaultBrand.js';

export class NewsletterRepository {
  settings() {
    return query('SELECT * FROM communication_settings WHERE id = 1 LIMIT 1').then((r) => r[0] || null);
  }

  // Keyed on (brand, channel, contact) — the table's own unique key since
  // migration 102, so a person may hold one email and one WhatsApp
  // subscription without either colliding.
  async byContact(normalizedContact, channel = 'EMAIL', brandId = null) {
    const resolvedBrandId = await resolveBrandId(brandId);
    return query(
      'SELECT * FROM newsletter_subscribers WHERE normalized_contact = ? AND channel = ? AND brand_id = ? LIMIT 1',
      [normalizedContact, channel, resolvedBrandId]).then((r) => r[0] || null);
  }

  byEmail(normalizedEmail, brandId = null) {
    return this.byContact(normalizedEmail, 'EMAIL', brandId);
  }

  byConfirmToken(token) {
    return query('SELECT * FROM newsletter_subscribers WHERE confirm_token = ? LIMIT 1', [token]).then((r) => r[0] || null);
  }

  async insert({ normalizedContact, rawContact, channel = 'EMAIL', customerId, status, source, confirmToken, brandId = null }) {
    const id = randomUUID();
    const resolvedBrandId = await resolveBrandId(brandId);
    // normalized_email / raw_email stay populated for EMAIL rows because they
    // are still read elsewhere; a WHATSAPP row leaves them null.
    const isEmail = channel === 'EMAIL';
    await query(
      `INSERT INTO newsletter_subscribers
         (id, brand_id, channel, normalized_contact, raw_contact, normalized_email, raw_email,
          customer_id, status, source, confirm_token, confirmed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, resolvedBrandId, channel, normalizedContact, rawContact,
        isEmail ? normalizedContact : null, isEmail ? rawContact : null,
        customerId || null, status, source, confirmToken || null,
        status === 'SUBSCRIBED' ? new Date() : null]);
    return id;
  }

  update(id, fields) {
    const sets = ['updated_at = NOW(3)'];
    const params = [];
    for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = ?`); params.push(v); }
    params.push(id);
    return query(`UPDATE newsletter_subscribers SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  linkCustomerByEmail(normalizedEmail, customerId) {
    return query(
      'UPDATE newsletter_subscribers SET customer_id = ?, updated_at = NOW(3) WHERE normalized_email = ? AND customer_id IS NULL',
      [customerId, normalizedEmail]);
  }

  async list({ status = null, source = null, channel = null, search = null, limit = 50, offset = 0, brandId = null } = {}) {
    const resolvedBrandId = await resolveBrandId(brandId);
    const where = ['brand_id = ?'];
    const params = [resolvedBrandId];
    if (status) { where.push('status = ?'); params.push(status); }
    if (source) { where.push('source = ?'); params.push(source); }
    if (channel) { where.push('channel = ?'); params.push(channel); }
    if (search) { where.push('normalized_contact LIKE ?'); params.push(`%${String(search).trim().toLowerCase()}%`); }
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    return query(
      `SELECT id, channel, normalized_contact, normalized_email, customer_id, status, source, confirmed_at, unsubscribed_at, created_at
         FROM newsletter_subscribers WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`, params);
  }

  byId(id) {
    return query('SELECT * FROM newsletter_subscribers WHERE id = ? LIMIT 1', [id]).then((r) => r[0] || null);
  }
}

export const newsletterRepository = new NewsletterRepository();
