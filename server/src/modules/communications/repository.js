import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';
import { resolveBrandId } from '../../utils/defaultBrand.js';

const exec = async (connection, sql, params = []) =>
  (connection ? (await connection.execute(sql, params))[0] : query(sql, params));

const parse = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);

// Multi-company (DESIGN.md §4.1) — Phase 4. brandId is optional on every
// method here and defaults to the `is_default` brand (see utils/
// defaultBrand.js) — this module is called from deep system-triggered
// paths (notification emit() call sites, background workers) with no
// request in scope, as well as admin routes that DO have a real brandId.
export class CommunicationRepository {
  // ---- templates ---------------------------------------------------
  async listTemplates({ channel = null, classification = null, brandId = null } = {}) {
    const resolvedBrandId = await resolveBrandId(brandId);
    const where = ['brand_id = ?'];
    const params = [resolvedBrandId];
    if (channel) { where.push('channel = ?'); params.push(channel); }
    if (classification) { where.push('classification = ?'); params.push(classification); }
    return query(
      `SELECT * FROM communication_templates WHERE ${where.join(' AND ')}
        ORDER BY template_key, channel, version DESC`, params);
  }

  templateById(id) {
    return query('SELECT * FROM communication_templates WHERE id = ? LIMIT 1', [id]).then((r) => r[0] || null);
  }

  /** The current ACTIVE template for a key+channel (highest active version). */
  async activeTemplate(connection, templateKey, channel, brandId = null) {
    const resolvedBrandId = await resolveBrandId(brandId);
    return exec(connection,
      `SELECT * FROM communication_templates
        WHERE brand_id = ? AND template_key = ? AND channel = ? AND status = 'ACTIVE'
        ORDER BY version DESC LIMIT 1`, [resolvedBrandId, templateKey, channel]).then((r) => r[0] || null);
  }

  async maxTemplateVersion(templateKey, channel, brandId = null) {
    const resolvedBrandId = await resolveBrandId(brandId);
    return query('SELECT COALESCE(MAX(version), 0) AS v FROM communication_templates WHERE brand_id = ? AND template_key = ? AND channel = ?', [resolvedBrandId, templateKey, channel])
      .then((r) => Number(r[0].v));
  }

  async insertTemplate(t) {
    const id = randomUUID();
    const brandId = await resolveBrandId(t.brandId);
    await query(
      `INSERT INTO communication_templates
        (id, brand_id, template_key, channel, classification, version, status, subject, body_template, variable_schema, provider_template_ref, created_by_staff_id)
       VALUES (?,?,?,?,?,?,?,?,?,CAST(? AS JSON),?,?)`,
      [id, brandId, t.templateKey, t.channel, t.classification, t.version, t.status || 'DRAFT', t.subject ?? null,
        t.bodyTemplate, JSON.stringify(t.variableSchema || {}), t.providerTemplateRef ?? null, t.staffId ?? null]);
    return this.templateById(id);
  }

  updateTemplateStatus(id, status) {
    return query('UPDATE communication_templates SET status = ?, updated_at = NOW(3) WHERE id = ?', [status, id]);
  }

  // ---- outbox messages -------------------------------------------
  /**
   * Idempotent enqueue on `dedupe_key`. Returns { id, created }. A worker retry
   * or a duplicate domain event never creates a second logical message (§131).
   */
  async enqueueMessage(connection, m) {
    const id = randomUUID();
    try {
      await exec(connection,
        `INSERT INTO communication_messages
          (id, dedupe_key, classification, channel, purpose, template_key, template_version, provider_template_ref,
           business_event_id, policy_key, broadcast_id, recipient_customer_id, recipient_contact_key, variables_json,
           rendered_subject, rendered_body, status, next_attempt_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,CAST(? AS JSON),?,?, 'QUEUED', NOW(3))`,
        [id, m.dedupeKey, m.classification, m.channel, m.purpose ?? null, m.templateKey, m.templateVersion, m.providerTemplateRef ?? null,
          m.businessEventId, m.policyKey, m.broadcastId ?? null, m.recipientCustomerId ?? null, m.recipientContactKey,
          JSON.stringify(m.variables ?? null), m.renderedSubject ?? null, m.renderedBody ?? null]);
    } catch (err) {
      // uk_comm_messages_dedupe — a worker retry / duplicate domain event.
      if (err.code === 'ER_DUP_ENTRY') {
        const existing = await exec(connection, 'SELECT id FROM communication_messages WHERE dedupe_key = ? LIMIT 1', [m.dedupeKey]);
        return { id: existing[0].id, created: false };
      }
      throw err;
    }
    await this.recordEvent(connection, id, { eventType: 'QUEUED', toStatus: 'QUEUED' });
    return { id, created: true };
  }

  messageById(connection, id, { lock = false } = {}) {
    return exec(connection, `SELECT * FROM communication_messages WHERE id = ? LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [id])
      .then((r) => (r[0] ? { ...r[0], variables_json: parse(r[0].variables_json) } : null));
  }

  messageByProviderRef(connection, providerCode, providerMessageId) {
    return exec(connection,
      'SELECT * FROM communication_messages WHERE provider_code = ? AND provider_message_id = ? LIMIT 1',
      [providerCode, providerMessageId]).then((r) => r[0] || null);
  }

  /** Claim due messages for a worker pass (FOR UPDATE SKIP LOCKED). */
  async claimDue(connection, limit) {
    const rows = await exec(connection,
      `SELECT id FROM communication_messages
        WHERE status IN ('QUEUED','FAILED') AND (next_attempt_at IS NULL OR next_attempt_at <= NOW(3))
          AND attempt_count < max_attempts
        ORDER BY next_attempt_at LIMIT ${Number(limit)} FOR UPDATE SKIP LOCKED`, []);
    const ids = rows.map((r) => r.id);
    if (ids.length) {
      await exec(connection,
        `UPDATE communication_messages SET locked_at = NOW(3) WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    }
    return ids;
  }

  /** Compare-and-set status transition. */
  async transition(connection, id, { fromVersion, toStatus, patch = {} }) {
    const cols = Object.keys(patch);
    const sets = cols.map((c) => `${c} = ?`);
    const res = await exec(connection,
      `UPDATE communication_messages
          SET status = ?, status_version = status_version + 1, updated_at = NOW(3)${sets.length ? `, ${sets.join(', ')}` : ''}
        WHERE id = ? AND status_version = ?`,
      [toStatus, ...cols.map((c) => patch[c]), id, fromVersion]);
    return res.affectedRows === 1;
  }

  /** @returns {Promise<boolean>} true if a NEW event row was written (false = a deduped replay). */
  async recordEvent(connection, messageId, e) {
    try {
      await exec(connection,
        `INSERT INTO communication_message_events (id, message_id, event_type, from_status, to_status, provider_event_key, detail_json)
         VALUES (?,?,?,?,?,?, CAST(? AS JSON))`,
        [randomUUID(), messageId, e.eventType, e.fromStatus ?? null, e.toStatus ?? null, e.providerEventKey ?? null,
          JSON.stringify(e.detail ?? null)]);
      return true;
    } catch (err) {
      // uk_comm_message_events_provider_key — a replayed provider webhook.
      if (err.code === 'ER_DUP_ENTRY') return false;
      throw err;
    }
  }

  events(messageId) {
    return query(
      'SELECT event_type, from_status, to_status, provider_event_key, occurred_at FROM communication_message_events WHERE message_id = ? ORDER BY occurred_at, id',
      [messageId]);
  }

  messagesForEvent(businessEventId) {
    return query('SELECT * FROM communication_messages WHERE business_event_id = ? ORDER BY created_at', [businessEventId]);
  }

}

export const communicationRepository = new CommunicationRepository();
