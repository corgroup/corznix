import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';

const exec = async (connection, sql, params = []) =>
  (connection ? (await connection.execute(sql, params))[0] : query(sql, params));
const parse = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);

export const platformRepository = {
  // ---- provider_configurations -----------------------------------
  configFor(capability, providerKey) {
    return query('SELECT * FROM provider_configurations WHERE capability = ? AND provider_key = ? LIMIT 1', [capability, providerKey])
      .then((r) => (r[0] ? { ...r[0], config_json: parse(r[0].config_json) } : null));
  },
  allConfigs() {
    return query('SELECT * FROM provider_configurations').then((rows) => rows.map((r) => ({ ...r, config_json: parse(r.config_json) })));
  },
  async upsertConfig(connection, { capability, providerKey, enabled, priority, config, version, staffId }) {
    await exec(connection,
      `INSERT INTO provider_configurations (id, capability, provider_key, enabled, priority, config_json, config_version, updated_by_staff_id)
       VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?)
       AS new
       ON DUPLICATE KEY UPDATE enabled = new.enabled, priority = new.priority, config_json = new.config_json,
         config_version = new.config_version, updated_by_staff_id = new.updated_by_staff_id, updated_at = NOW(3)`,
      [randomUUID(), capability, providerKey, enabled ? 1 : 0, priority, JSON.stringify(config ?? {}), version, staffId ?? null]);
  },
  insertConfigRevision(connection, r) {
    return exec(connection,
      `INSERT INTO provider_configuration_revisions (id, capability, provider_key, config_version, enabled, priority, config_json, changed_by_staff_id, note)
       VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?)`,
      [randomUUID(), r.capability, r.providerKey, r.version, r.enabled ? 1 : 0, r.priority, JSON.stringify(r.config ?? {}), r.staffId ?? null, r.note ?? null]);
  },
  revisions(capability, providerKey) {
    return query(
      `SELECT r.*, su.email AS changed_by_email FROM provider_configuration_revisions r
         LEFT JOIN staff_users su ON su.id = r.changed_by_staff_id
        WHERE r.capability = ? AND r.provider_key = ? ORDER BY r.config_version DESC`, [capability, providerKey])
      .then((rows) => rows.map((r) => ({ ...r, config_json: parse(r.config_json) })));
  },
  revision(capability, providerKey, version) {
    return query('SELECT * FROM provider_configuration_revisions WHERE capability = ? AND provider_key = ? AND config_version = ? LIMIT 1', [capability, providerKey, version])
      .then((r) => (r[0] ? { ...r[0], config_json: parse(r[0].config_json) } : null));
  },

  // ---- provider_health ------------------------------------------
  health(capability, providerKey) {
    return query('SELECT * FROM provider_health WHERE capability = ? AND provider_key = ? LIMIT 1', [capability, providerKey])
      .then((r) => (r[0] ? { ...r[0], detail_json: parse(r[0].detail_json) } : null));
  },
  allHealth() {
    return query('SELECT * FROM provider_health').then((rows) => rows.map((r) => ({ ...r, detail_json: parse(r.detail_json) })));
  },
  async upsertHealth(h) {
    await query(
      `INSERT INTO provider_health (capability, provider_key, status, secret_status, last_success_at, last_failure_at, last_checked_at, recent_error_ratio_bps, avg_latency_ms, detail_json)
       VALUES (?, ?, ?, ?, ?, ?, NOW(3), ?, ?, CAST(? AS JSON))
       AS new
       ON DUPLICATE KEY UPDATE status = new.status, secret_status = new.secret_status,
         last_success_at = COALESCE(new.last_success_at, provider_health.last_success_at),
         last_failure_at = COALESCE(new.last_failure_at, provider_health.last_failure_at),
         last_checked_at = NOW(3), recent_error_ratio_bps = new.recent_error_ratio_bps,
         avg_latency_ms = new.avg_latency_ms, detail_json = new.detail_json`,
      [h.capability, h.providerKey, h.status, h.secretStatus, h.lastSuccessAt ?? null, h.lastFailureAt ?? null,
        h.errorRatioBps ?? null, h.avgLatencyMs ?? null, JSON.stringify(h.detail ?? null)]);
  },
  recordHealthEvent(capability, providerKey, fromStatus, toStatus, reason) {
    return query(
      `INSERT INTO provider_health_events (id, capability, provider_key, from_status, to_status, reason) VALUES (?, ?, ?, ?, ?, ?)`,
      [randomUUID(), capability, providerKey, fromStatus ?? null, toStatus, reason ?? null]);
  },
  healthEvents(capability, providerKey) {
    return query('SELECT from_status, to_status, reason, created_at FROM provider_health_events WHERE capability = ? AND provider_key = ? ORDER BY created_at DESC LIMIT 30', [capability, providerKey]);
  },

  // ---- provider_attempts (observability) -----------------------
  insertAttempt(a) {
    return query(
      `INSERT INTO provider_attempts (id, correlation_id, capability, provider_key, operation, resource_type, resource_id, attempt_number, outcome, normalized_error_code, http_status, duration_ms, config_version, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), a.correlationId, a.capability, a.providerKey, a.operation, a.resourceType ?? null, a.resourceId ?? null,
        a.attemptNumber ?? 1, a.outcome, a.normalizedErrorCode ?? null, a.httpStatus ?? null, a.durationMs ?? null,
        a.configVersion ?? null, a.startedAt ?? new Date()]);
  },
  recentAttempts(capability, providerKey, sinceMs) {
    return query(
      `SELECT outcome, normalized_error_code, duration_ms, started_at FROM provider_attempts
        WHERE capability = ? AND provider_key = ? AND started_at >= DATE_SUB(NOW(3), INTERVAL ? SECOND)
        ORDER BY started_at DESC LIMIT 200`, [capability, providerKey, Math.round(sinceMs / 1000)]);
  },
  listAttempts({ capability, providerKey, outcome, offset, limit }) {
    const where = [];
    const params = [];
    if (capability) { where.push('capability = ?'); params.push(capability); }
    if (providerKey) { where.push('provider_key = ?'); params.push(providerKey); }
    if (outcome) { where.push('outcome = ?'); params.push(outcome); }
    return query(
      `SELECT * FROM provider_attempts ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY started_at DESC LIMIT ${limit} OFFSET ${offset}`, params);
  },

  // ---- provider_webhook_inbox ---------------------------------
  async insertInbox(connection, w) {
    const id = randomUUID();
    try {
      await exec(connection,
        `INSERT INTO provider_webhook_inbox
          (id, capability, provider_key, provider_event_id, dedupe_key, signature_valid, verification_status,
           processing_status, normalized_event_type, resource_type, resource_id, payload_sha256, safe_summary_json, correlation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, CAST(? AS JSON), ?)`,
        [id, w.capability, w.providerKey, w.providerEventId ?? null, w.dedupeKey,
          w.signatureValid == null ? null : (w.signatureValid ? 1 : 0),
          w.signatureValid === false ? 'REJECTED' : (w.signatureValid ? 'VERIFIED' : 'UNVERIFIED'),
          w.normalizedEventType ?? null, w.resourceType ?? null, w.resourceId ?? null,
          w.payloadSha256 ?? null, JSON.stringify(w.safeSummary ?? null), w.correlationId ?? null]);
      return { id, created: true };
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        const existing = await exec(connection, 'SELECT id FROM provider_webhook_inbox WHERE dedupe_key = ? LIMIT 1', [w.dedupeKey]);
        return { id: existing[0].id, created: false };
      }
      throw err;
    }
  },
  inboxById(id) {
    return query('SELECT * FROM provider_webhook_inbox WHERE id = ? LIMIT 1', [id])
      .then((r) => (r[0] ? { ...r[0], safe_summary_json: parse(r[0].safe_summary_json) } : null));
  },
  listInbox({ processingStatus, capability, offset, limit }) {
    const where = [];
    const params = [];
    if (processingStatus) { where.push('processing_status = ?'); params.push(processingStatus); }
    if (capability) { where.push('capability = ?'); params.push(capability); }
    return query(
      `SELECT id, capability, provider_key, provider_event_id, verification_status, processing_status,
              normalized_event_type, resource_type, resource_id, attempt_count, last_error_code, received_at, processed_at
         FROM provider_webhook_inbox ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY received_at DESC LIMIT ${limit} OFFSET ${offset}`, params);
  },
  markInbox(id, { processingStatus, lastErrorCode, bumpAttempt }) {
    return query(
      `UPDATE provider_webhook_inbox
          SET processing_status = ?, last_error_code = ?,
              attempt_count = attempt_count + ?, processed_at = IF(? IN ('APPLIED','IGNORED','REPLAYED'), NOW(3), processed_at)
        WHERE id = ?`,
      [processingStatus, lastErrorCode ?? null, bumpAttempt ? 1 : 0, processingStatus, id]);
  },

  // ---- platform_outbox --------------------------------------
  insertOutbox(connection, o) {
    const id = randomUUID();
    return exec(connection,
      `INSERT INTO platform_outbox (id, brand_id, event_type, aggregate_type, aggregate_id, payload_json, status, next_attempt_at, correlation_id)
       VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), 'PENDING', NOW(3), ?)`,
      [id, o.brandId, o.eventType, o.aggregateType ?? null, o.aggregateId ?? null, JSON.stringify(o.payload ?? null), o.correlationId ?? null])
      .then(() => id);
  },
  // Wave 8J-4 — a worker that crashed after claiming leaves a row PROCESSING
  // forever. Any worker reclaims such rows (lease expiry) before its own
  // claim. Bounded by attempt_count/max_attempts so this is not a retry loop.
  reclaimStaleOutbox(connection, staleMs) {
    return exec(connection,
      `UPDATE platform_outbox
          SET status = 'PENDING', locked_at = NULL, locked_by = NULL, last_error_code = 'RECLAIMED_STALE_LOCK'
        WHERE status = 'PROCESSING' AND locked_at IS NOT NULL
          AND locked_at < DATE_SUB(NOW(3), INTERVAL ? SECOND)
          AND attempt_count < max_attempts`,
      [Math.max(1, Math.round(staleMs / 1000))]);
  },
  async claimOutbox(connection, workerId, limit) {
    const rows = await exec(connection,
      `SELECT id FROM platform_outbox
        WHERE status IN ('PENDING','FAILED') AND (next_attempt_at IS NULL OR next_attempt_at <= NOW(3)) AND attempt_count < max_attempts
        ORDER BY next_attempt_at LIMIT ${Number(limit)} FOR UPDATE SKIP LOCKED`, []);
    const ids = rows.map((r) => r.id);
    if (ids.length) {
      await exec(connection,
        `UPDATE platform_outbox SET status = 'PROCESSING', locked_at = NOW(3), locked_by = ?, attempt_count = attempt_count + 1
          WHERE id IN (${ids.map(() => '?').join(',')})`, [workerId, ...ids]);
    }
    return ids;
  },
  outboxById(id) {
    return query('SELECT * FROM platform_outbox WHERE id = ? LIMIT 1', [id]).then((r) => (r[0] ? { ...r[0], payload_json: parse(r[0].payload_json) } : null));
  },
  finishOutbox(id, { status, outcomeClass, lastErrorCode, nextAttemptAt }) {
    return query(
      `UPDATE platform_outbox
          SET status = ?, outcome_class = ?, last_error_code = ?, next_attempt_at = ?, locked_at = NULL, locked_by = NULL,
              processed_at = IF(? IN ('PROCESSED','DEAD','CANCELLED','RECONCILIATION_REQUIRED'), NOW(3), processed_at)
        WHERE id = ?`,
      [status, outcomeClass ?? null, lastErrorCode ?? null, nextAttemptAt ?? null, status, id]);
  },
  listOutbox({ status, offset, limit }) {
    const where = status ? 'WHERE status = ?' : '';
    return query(
      `SELECT id, event_type, aggregate_type, aggregate_id, status, outcome_class, attempt_count, max_attempts,
              next_attempt_at, last_error_code, created_at, processed_at
         FROM platform_outbox ${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`, status ? [status] : []);
  },
};
