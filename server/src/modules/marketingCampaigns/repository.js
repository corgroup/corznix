import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';
import { withTransaction } from '../../database/connection/transaction.js';

async function execute(connection, sql, params = []) {
  if (!connection) return query(sql, params);
  const [rows] = await connection.execute(sql, params);
  return rows;
}

// Every message this module enqueues is tagged with the campaign and the
// recipient row, so the report can join what the communications engine
// actually did back to the snapshot without needing a communication_broadcasts
// row (those are segment-based; this audience is not).
export const campaignEventPrefix = (campaignId) => `marketing_campaign:${campaignId}:`;

const CAMPAIGN_FIELDS = [
  'name', 'campaign_type', 'status', 'email_enabled', 'whatsapp_enabled',
  'audience_sources', 'offer_name', 'offer_details', 'collection_slug',
  'image_url', 'cta_label', 'cta_url', 'email_subject', 'email_body',
  'whatsapp_template_ref', 'batch_size', 'scheduled_at', 'started_at', 'finished_at',
  'trigger_type', 'trigger_event', 'trigger_config', 'paused_from',
];

export class MarketingCampaignRepository {
  // ---- audience lists (reusable) -----------------------------------
  listLists(brandId) {
    return query(
      `SELECT l.*,
              (SELECT COUNT(*) FROM marketing_audience_contacts c
                WHERE c.list_id = l.id AND c.import_status = 'VALID') AS usable_contacts
         FROM marketing_audience_lists l
        WHERE l.brand_id = ? ORDER BY l.created_at DESC`, [brandId]);
  }

  async listById(listId, brandId) {
    const [row] = await query('SELECT * FROM marketing_audience_lists WHERE id = ? AND brand_id = ? LIMIT 1', [listId, brandId]);
    return row || null;
  }

  /** One upload: the list row plus every parsed line, in one transaction. */
  async insertList({ brandId, name, filename, counts, rows, staffId }) {
    const listId = randomUUID();
    await withTransaction(async (tx) => {
      await execute(tx,
        `INSERT INTO marketing_audience_lists
           (id, brand_id, name, filename, total_rows, valid_rows, invalid_rows, duplicate_rows,
            missing_phone_rows, missing_email_rows, invalid_phone_rows, invalid_email_rows, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [listId, brandId, name, filename, counts.total, counts.valid, counts.invalid, counts.duplicate,
          counts.missingPhone, counts.missingEmail, counts.invalidPhone, counts.invalidEmail, staffId || null]);

      const CHUNK = 500;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const slice = rows.slice(i, i + CHUNK);
        const values = slice.map(() => '(?,?,?,?,?,?,?,?,?,?)').join(',');
        const params = slice.flatMap((r) => [
          randomUUID(), listId, r.sourceRow, r.rawName, r.rawPhone, r.rawEmail,
          r.phoneE164, r.email, r.importStatus, r.invalidReason,
        ]);
        // eslint-disable-next-line no-await-in-loop
        await execute(tx,
          `INSERT INTO marketing_audience_contacts
             (id, list_id, source_row, raw_name, raw_phone, raw_email, phone_e164, email, import_status, invalid_reason)
           VALUES ${values}`, params);
      }

      // Match to people we already know, by either identifier, so an upload
      // never creates a second copy of an existing customer. normalized_value
      // is the indexed column and already holds the same canonical forms this
      // importer produces (+91XXXXXXXXXX, lowercased email).
      await execute(tx,
        `UPDATE marketing_audience_contacts mc
            JOIN customer_contacts cc
              ON (cc.contact_type = 'PHONE' AND cc.normalized_value = mc.phone_e164)
              OR (cc.contact_type = 'EMAIL' AND cc.normalized_value = mc.email)
            SET mc.customer_id = cc.customer_id
          WHERE mc.list_id = ? AND mc.customer_id IS NULL`, [listId]);

      // VALID rows only. Counting every matched row let a DUPLICATE of a known
      // customer count twice, so the preview showed existing customers 2 and
      // new contacts -1 for a file with one valid row (production, 2026-09-17).
      await execute(tx,
        `UPDATE marketing_audience_lists l
            SET existing_customer_rows = (SELECT COUNT(*) FROM marketing_audience_contacts c
                                           WHERE c.list_id = l.id AND c.customer_id IS NOT NULL
                                             AND c.import_status = 'VALID')
          WHERE l.id = ?`, [listId]);
    });
    return listId;
  }

  /** A sample of each bucket, for the pre-confirm preview. */
  async listSample(listId, { perBucket = 10 } = {}) {
    const buckets = {};
    for (const status of ['VALID', 'INVALID', 'DUPLICATE']) {
      // eslint-disable-next-line no-await-in-loop
      buckets[status] = await query(
        `SELECT source_row, raw_name, raw_phone, raw_email, phone_e164, email, invalid_reason, customer_id
           FROM marketing_audience_contacts WHERE list_id = ? AND import_status = ?
          ORDER BY source_row LIMIT ?`, [listId, status, perBucket]);
    }
    return buckets;
  }

  async confirmList(listId, brandId) {
    const res = await query(
      'UPDATE marketing_audience_lists SET confirmed_at = NOW(3) WHERE id = ? AND brand_id = ? AND confirmed_at IS NULL',
      [listId, brandId]);
    return Number(res?.affectedRows || 0) > 0;
  }

  async discardList(listId, brandId) {
    const res = await query(
      'DELETE FROM marketing_audience_lists WHERE id = ? AND brand_id = ? AND confirmed_at IS NULL',
      [listId, brandId]);
    return Number(res?.affectedRows || 0) > 0;
  }

  // ---- campaign types (data, not code) -------------------------------
  types({ activeOnly = true } = {}) {
    return query(
      `SELECT type_key, label, description, suggested_trigger, content_fields, sort_order, is_active
         FROM campaign_types ${activeOnly ? 'WHERE is_active = 1' : ''} ORDER BY sort_order, label`);
  }

  async typeByKey(key) {
    const [row] = await query('SELECT * FROM campaign_types WHERE type_key = ? LIMIT 1', [key]);
    return row || null;
  }

  // ---- campaigns ---------------------------------------------------
  list(brandId) {
    return query(
      `SELECT c.*,
              (SELECT COUNT(*) FROM marketing_campaign_recipients r WHERE r.campaign_id = c.id) AS snapshot_size,
              (SELECT COUNT(*) FROM campaign_runs cr WHERE cr.campaign_id = c.id) AS run_count,
              (SELECT COUNT(*) FROM abandoned_cart_sends s WHERE s.campaign_id = c.id) AS reminder_count
         FROM marketing_campaigns c WHERE c.brand_id = ? ORDER BY c.created_at DESC`, [brandId]);
  }

  // ---- channels ------------------------------------------------------
  channels(campaignIds) {
    const ids = Array.isArray(campaignIds) ? campaignIds : [campaignIds];
    if (!ids.length) return Promise.resolve([]);
    return query(
      `SELECT campaign_id, channel, template_key, provider_template_ref, variable_mapping
         FROM campaign_channels WHERE campaign_id IN (${ids.map(() => '?').join(',')}) ORDER BY channel`, ids);
  }

  /** Replace a campaign's channels, keeping the legacy enabled flags in step. */
  async replaceChannels(campaignId, channels) {
    await withTransaction(async (tx) => {
      await execute(tx, 'DELETE FROM campaign_channels WHERE campaign_id = ?', [campaignId]);
      for (const c of channels) {
        // eslint-disable-next-line no-await-in-loop
        await execute(tx,
          `INSERT INTO campaign_channels (id, campaign_id, channel, template_key, provider_template_ref, variable_mapping)
           VALUES (?,?,?,?,?,?)`,
          [randomUUID(), campaignId, c.channel, c.templateKey, c.providerTemplateRef || null,
            c.variableMapping ? JSON.stringify(c.variableMapping) : null]);
      }
      await execute(tx,
        'UPDATE marketing_campaigns SET email_enabled = ?, whatsapp_enabled = ? WHERE id = ?',
        [channels.some((c) => c.channel === 'EMAIL') ? 1 : 0, channels.some((c) => c.channel === 'WHATSAPP') ? 1 : 0, campaignId]);
    });
  }

  // ---- runs ------------------------------------------------------------
  /**
   * Start a run. The UNIQUE (campaign_id, trigger_key) key is the guarantee
   * that one campaign never runs twice for the same send / time / event: a
   * second attempt inserts nothing and returns created:false.
   */
  async createRun(campaignId, triggerKey, { context = null, config = null } = {}) {
    const id = randomUUID();
    const res = await query(
      `INSERT IGNORE INTO campaign_runs (id, campaign_id, trigger_key, status, context, config)
       VALUES (?,?,?,'RUNNING',?,?)`,
      [id, campaignId, String(triggerKey).slice(0, 191),
        context ? JSON.stringify(context) : null, config ? JSON.stringify(config) : null]);
    return { id, created: Number(res?.affectedRows || 0) > 0 };
  }

  runsFor(campaignId) {
    return query(
      `SELECT r.id, r.trigger_key, r.status, r.context, r.started_at, r.finished_at,
              (SELECT COUNT(*) FROM marketing_campaign_recipients x WHERE x.run_id = r.id) AS recipients,
              (SELECT COUNT(*) FROM marketing_campaign_recipients x WHERE x.run_id = r.id AND x.state = 'PENDING') AS pending
         FROM campaign_runs r WHERE r.campaign_id = ? ORDER BY r.started_at DESC LIMIT 100`, [campaignId]);
  }

  /** Runs with work to do, for campaigns that are live. */
  runningRuns({ limit = 20 } = {}) {
    return query(
      `SELECT r.id AS run_id, r.trigger_key AS run_trigger_key, c.*
         FROM campaign_runs r JOIN marketing_campaigns c ON c.id = r.campaign_id
        WHERE r.status = 'RUNNING' AND c.status = 'ACTIVE'
        ORDER BY r.started_at ASC LIMIT ?`, [limit]);
  }

  async setRunsStatus(campaignId, from, to) {
    const finishing = ['COMPLETED', 'CANCELLED'].includes(to);
    await query(
      `UPDATE campaign_runs SET status = ?${finishing ? ', finished_at = NOW(3)' : ''}
        WHERE campaign_id = ? AND status IN (${from.map(() => '?').join(',')})`, [to, campaignId, ...from]);
  }

  completeRun(runId) {
    return query("UPDATE campaign_runs SET status = 'COMPLETED', finished_at = NOW(3) WHERE id = ? AND status = 'RUNNING'", [runId]);
  }

  async byId(id, brandId) {
    const [row] = await query('SELECT * FROM marketing_campaigns WHERE id = ? AND brand_id = ? LIMIT 1', [id, brandId]);
    return row || null;
  }

  async insert(brandId, data, staffId) {
    const id = randomUUID();
    const cols = CAMPAIGN_FIELDS.filter((f) => data[f] !== undefined);
    await query(
      `INSERT INTO marketing_campaigns (id, brand_id, created_by${cols.length ? `, ${cols.join(', ')}` : ''})
       VALUES (?,?,?${cols.map(() => ',?').join('')})`,
      [id, brandId, staffId || null, ...cols.map((f) => data[f])]);
    return this.byId(id, brandId);
  }

  async update(id, brandId, patch) {
    const cols = CAMPAIGN_FIELDS.filter((f) => patch[f] !== undefined);
    if (cols.length) {
      await query(
        `UPDATE marketing_campaigns SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND brand_id = ?`,
        [...cols.map((f) => patch[f]), id, brandId]);
    }
    return this.byId(id, brandId);
  }

  async remove(id, brandId) {
    const res = await query('DELETE FROM marketing_campaigns WHERE id = ? AND brand_id = ?', [id, brandId]);
    return Number(res?.affectedRows || 0) > 0;
  }

  /**
   * Status change guarded by the status it is moving FROM, so two operators
   * pressing Pause and Cancel at the same moment cannot both win.
   */
  async transition(id, brandId, from, to, patch = {}) {
    const cols = Object.keys(patch).filter((f) => CAMPAIGN_FIELDS.includes(f));
    const res = await query(
      `UPDATE marketing_campaigns SET status = ?${cols.map((c) => `, ${c} = ?`).join('')}
        WHERE id = ? AND brand_id = ? AND status IN (${from.map(() => '?').join(',')})`,
      [to, ...cols.map((c) => patch[c]), id, brandId, ...from]);
    return Number(res?.affectedRows || 0) > 0;
  }

  /** Scheduled campaigns whose time has arrived. */
  dueScheduled({ limit = 20, now = new Date() } = {}) {
    return query(
      `SELECT * FROM marketing_campaigns
        WHERE status = 'SCHEDULED' AND trigger_type = 'SCHEDULED'
          AND scheduled_at IS NOT NULL AND scheduled_at <= ?
        ORDER BY scheduled_at ASC LIMIT ?`, [now, limit]);
  }

  // ---- audience sources --------------------------------------------
  /**
   * Registered users, filtered. Returns one row per (contact, channel) so the
   * snapshot can dedupe uniformly across every source.
   *
   * Only VERIFIED contacts are ever returned: an unverified address is one
   * somebody typed, not one we know reaches them.
   */
  // Registered = every customer who is not suspended, including those who
  // signed in but never finished their profile (owner decision, 2026-09-17).
  #registeredWhere(filter) {
    const where = ['c.brand_id = ?', "c.status IN ('ACTIVE', 'PENDING_PROFILE')"];
    const ORDER_EXISTS = `EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.order_status <> 'CANCELLED')`;
    switch (filter) {
      case 'HAS_ORDERED': where.push(ORDER_EXISTS); break;
      case 'NEVER_ORDERED': where.push(`NOT ${ORDER_EXISTS}`); break;
      case 'NEW_USERS': where.push('c.created_at >= (NOW() - INTERVAL 30 DAY)'); break;
      case 'ALL': default: break;
    }
    return where;
  }

  /** How many registered customers match, whatever their contact state. */
  async registeredCustomerCount(brandId, filter) {
    const [row] = await query(`SELECT COUNT(*) AS n FROM customers c WHERE ${this.#registeredWhere(filter).join(' AND ')}`, [brandId]);
    return Number(row.n);
  }

  registeredUsers(brandId, filter, { limit = 200000 } = {}) {
    const where = [...this.#registeredWhere(filter), 'cc.is_verified = 1'];
    const params = [brandId];
    return query(
      `SELECT DISTINCT c.id AS customer_id,
              TRIM(CONCAT(COALESCE(c.first_name,''), ' ', COALESCE(c.last_name,''))) AS display_name,
              cc.contact_type, cc.normalized_value AS contact_key
         FROM customers c
         JOIN customer_contacts cc ON cc.customer_id = c.id
        WHERE ${where.join(' AND ')}
        LIMIT ?`, [...params, limit]);
  }

  /** Verified contacts of the given customers (a segment's members). */
  customerContacts(brandId, customerIds) {
    if (!customerIds.length) return Promise.resolve([]);
    return query(
      `SELECT DISTINCT c.id AS customer_id,
              TRIM(CONCAT(COALESCE(c.first_name,''), ' ', COALESCE(c.last_name,''))) AS display_name,
              cc.contact_type, cc.normalized_value AS contact_key
         FROM customers c
         JOIN customer_contacts cc ON cc.customer_id = c.id AND cc.is_verified = 1
        WHERE c.brand_id = ? AND c.status IN ('ACTIVE', 'PENDING_PROFILE')
          AND c.id IN (${customerIds.map(() => '?').join(',')})`, [brandId, ...customerIds]);
  }

  /** Newsletter subscribers for one channel — the table is channel-agnostic. */
  subscribers(brandId, channel, { limit = 200000 } = {}) {
    return query(
      `SELECT s.customer_id, s.normalized_contact AS contact_key, s.channel,
              TRIM(CONCAT(COALESCE(c.first_name,''), ' ', COALESCE(c.last_name,''))) AS display_name
         FROM newsletter_subscribers s
         LEFT JOIN customers c ON c.id = s.customer_id
        WHERE s.brand_id = ? AND s.channel = ? AND s.status = 'SUBSCRIBED'
        LIMIT ?`, [brandId, channel, limit]);
  }

  /** Usable contacts from a confirmed uploaded list. */
  listContacts(listId, { limit = 200000 } = {}) {
    return query(
      `SELECT mc.customer_id, mc.raw_name AS display_name, mc.phone_e164, mc.email
         FROM marketing_audience_contacts mc
         JOIN marketing_audience_lists ml ON ml.id = mc.list_id
        WHERE mc.list_id = ? AND mc.import_status = 'VALID' AND ml.confirmed_at IS NOT NULL
        LIMIT ?`, [listId, limit]);
  }

  // ---- snapshot -----------------------------------------------------
  /**
   * Write the deduplicated snapshot. INSERT IGNORE leans on the UNIQUE key
   * (campaign_id, channel, contact_key): the same person arriving from the
   * customer table, the newsletter list and a CSV collapses to one row, and
   * the database is what guarantees it.
   */
  async insertRecipients(campaignId, runId, recipients) {
    let inserted = 0;
    const CHUNK = 500;
    for (let i = 0; i < recipients.length; i += CHUNK) {
      const slice = recipients.slice(i, i + CHUNK);
      const values = slice.map(() => '(?,?,?,?,?,?,?)').join(',');
      const params = slice.flatMap((r) => [
        randomUUID(), campaignId, runId, r.channel, r.contactKey,
        r.displayName ? String(r.displayName).slice(0, 200) : null, r.source,
      ]);
      // eslint-disable-next-line no-await-in-loop
      const res = await query(
        `INSERT IGNORE INTO marketing_campaign_recipients
           (id, campaign_id, run_id, channel, contact_key, display_name, source) VALUES ${values}`, params);
      inserted += Number(res?.affectedRows || 0);
    }
    // Link to customers where we can, in one pass rather than per recipient.
    await query(
      `UPDATE marketing_campaign_recipients r
          JOIN customer_contacts cc ON cc.normalized_value = r.contact_key
           AND cc.contact_type = IF(r.channel = 'EMAIL', 'EMAIL', 'PHONE')
          SET r.customer_id = cc.customer_id
        WHERE r.run_id = ? AND r.customer_id IS NULL`, [runId]);
    return inserted;
  }

  /**
   * Claim the next slice of PENDING recipients for one campaign. Claiming by
   * UPDATE first (rather than SELECT-then-send) means two workers, or a worker
   * that is restarted mid-batch, cannot send the same message twice.
   */
  async claimBatch(runId, size) {
    const claimId = randomUUID();
    await query(
      `UPDATE marketing_campaign_recipients
          SET state = 'QUEUED', reason = ?, queued_at = NOW(3), attempts = attempts + 1
        WHERE run_id = ? AND state = 'PENDING'
        ORDER BY created_at LIMIT ?`, [`claim:${claimId}`, runId, size]);
    return query(
      `SELECT * FROM marketing_campaign_recipients WHERE run_id = ? AND reason = ?`,
      [runId, `claim:${claimId}`]);
  }

  setRecipientState(id, state, reason = null, messageId = null) {
    return query(
      'UPDATE marketing_campaign_recipients SET state = ?, reason = ?, message_id = COALESCE(?, message_id) WHERE id = ?',
      [state, reason ? String(reason).slice(0, 200) : null, messageId, id]);
  }

  async pendingCount(runId) {
    const [row] = await query(
      "SELECT COUNT(*) AS n FROM marketing_campaign_recipients WHERE run_id = ? AND state = 'PENDING'", [runId]);
    return Number(row?.n || 0);
  }

  cancelPending(campaignId) {
    return query(
      `UPDATE marketing_campaign_recipients SET state = 'CANCELLED', reason = 'Campaign cancelled'
        WHERE campaign_id = ? AND state = 'PENDING'`, [campaignId]);
  }

  // ---- report -------------------------------------------------------
  /** Snapshot state, per channel, counted from the rows themselves. */
  /**
   * The delivery funnel per channel for the LAUNCH (test sends excluded and
   * reported separately): audience -> eligible -> queued -> provider accepted
   * -> delivered / failed, with failure reasons. "Accepted" is what the
   * provider answered; "delivered" only counts a provider delivery receipt,
   * which SMTP never sends and Infyntra has no webhook for — so delivery on
   * those channels is confirmed by an actual received message, not by this.
   */
  async funnel(campaignId) {
    const prefix = campaignEventPrefix(campaignId);
    const [snap, msgs, reasons] = await Promise.all([
      query(`SELECT channel, state, COUNT(*) AS n FROM marketing_campaign_recipients WHERE campaign_id = ? GROUP BY channel, state`, [campaignId]),
      query(`SELECT channel, status, (business_event_id LIKE ?) AS is_test, COUNT(*) AS n
               FROM communication_messages WHERE business_event_id LIKE ?
              GROUP BY channel, status, is_test`, [`${prefix}test:%`, `${prefix}%`]),
      query(`SELECT channel, COALESCE(last_error, suppressed_reason) AS reason, COUNT(*) AS n
               FROM communication_messages
              WHERE business_event_id LIKE ? AND business_event_id NOT LIKE ? AND status IN ('FAILED', 'SUPPRESSED', 'AMBIGUOUS')
              GROUP BY channel, reason`, [`${prefix}%`, `${prefix}test:%`]),
    ]);
    const out = {};
    for (const channel of ['EMAIL', 'WHATSAPP']) {
      const s = Object.fromEntries(snap.filter((r) => r.channel === channel).map((r) => [r.state, Number(r.n)]));
      const m = (test) => Object.fromEntries(msgs.filter((r) => r.channel === channel && Boolean(Number(r.is_test)) === test).map((r) => [r.status, Number(r.n)]));
      const launch = m(false);
      const sum = (o, keys) => keys.reduce((a, k) => a + (o[k] || 0), 0);
      out[channel] = {
        audience: Object.values(s).reduce((a, n) => a + n, 0),
        eligible: sum(s, ['PENDING', 'QUEUED', 'SENT', 'FAILED']),
        suppressedAtSnapshot: s.SUPPRESSED || 0,
        pending: s.PENDING || 0,
        queued: Object.values(launch).reduce((a, n) => a + n, 0),
        providerAccepted: sum(launch, ['SENT', 'DELIVERED']),
        delivered: launch.DELIVERED || 0,
        deliveryReceipts: channel === 'EMAIL' ? 'SMTP provides no delivery receipts' : 'Infyntra provides no delivery webhook',
        failed: launch.FAILED || 0,
        ambiguous: launch.AMBIGUOUS || 0,
        suppressedAtSend: launch.SUPPRESSED || 0,
        inFlight: sum(launch, ['QUEUED', 'SENDING']),
        failureReasons: reasons.filter((r) => r.channel === channel).map((r) => ({ reason: r.reason, n: Number(r.n) })),
        testSends: m(true),
      };
    }
    return out;
  }

  /**
   * Did this address receive a marketing message on this channel within the
   * last `hours`? Anything handed to (or accepted by) a provider counts —
   * campaigns and cart reminders alike. Test sends do not: they are explicit
   * staff actions to their own contacts.
   */
  async recentlyMarketed(contactKey, channel, hours) {
    if (!hours) return false;
    const rows = await query(
      `SELECT 1 FROM communication_messages
        WHERE recipient_contact_key = ? AND channel = ? AND classification = 'MARKETING'
          AND status IN ('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'AMBIGUOUS')
          AND created_at >= DATE_SUB(NOW(3), INTERVAL ? HOUR)
          AND business_event_id NOT LIKE '%:test:%'
          AND business_event_id NOT LIKE 'abandoned_cart_test:%'
        LIMIT 1`, [contactKey, channel, hours]);
    return rows.length > 0;
  }

  /**
   * The audience of a campaign, one row per (recipient, channel), with the
   * real message the engine sent for it. The message is found by the id
   * stored when it was queued, or by its business event id (rows queued
   * before that id was stored).
   */
  async recipients(campaignId, { limit = 50, offset = 0, channel = null } = {}) {
    const prefix = campaignEventPrefix(campaignId);
    const where = ['r.campaign_id = ?'];
    const params = [campaignId];
    if (channel) { where.push('r.channel = ?'); params.push(channel); }
    const [rows, [{ total }]] = await Promise.all([
      query(
        `SELECT r.id, r.run_id, r.channel, r.contact_key, r.display_name, r.customer_id, r.source, r.state, r.reason,
                r.queued_at, r.created_at,
                TRIM(CONCAT(COALESCE(cu.first_name, ''), ' ', COALESCE(cu.last_name, ''))) AS customer_name,
                (SELECT cc.normalized_value FROM customer_contacts cc
                  WHERE cc.customer_id = r.customer_id AND cc.contact_type = 'EMAIL' ORDER BY cc.is_verified DESC LIMIT 1) AS email,
                (SELECT cc.normalized_value FROM customer_contacts cc
                  WHERE cc.customer_id = r.customer_id AND cc.contact_type = 'PHONE' ORDER BY cc.is_verified DESC LIMIT 1) AS phone,
                m.status AS message_status, m.provider_message_id IS NOT NULL AS provider_accepted,
                m.sent_at, m.delivered_at, m.failed_at, m.last_error, m.suppressed_reason
           FROM marketing_campaign_recipients r
           LEFT JOIN customers cu ON cu.id = r.customer_id
           LEFT JOIN communication_messages m
             ON m.id = COALESCE(r.message_id,
                  (SELECT m2.id FROM communication_messages m2 WHERE m2.business_event_id = CONCAT(?, r.id) LIMIT 1))
          WHERE ${where.join(' AND ')}
          ORDER BY r.created_at ASC, r.channel
          LIMIT ? OFFSET ?`, [prefix, ...params, limit, offset]),
      query(`SELECT COUNT(*) AS total FROM marketing_campaign_recipients r WHERE ${where.join(' AND ')}`, params),
    ]);
    return {
      total: Number(total),
      recipients: rows.map((r) => ({
        id: r.id,
        runId: r.run_id,
        channel: r.channel,
        to: r.contact_key,
        customerId: r.customer_id,
        customerName: r.customer_name || r.display_name || null,
        email: r.email || (r.channel === 'EMAIL' ? r.contact_key : null),
        phone: r.phone || (r.channel === 'WHATSAPP' ? r.contact_key : null),
        source: r.source,
        // What the campaign decided for this recipient…
        state: r.state,
        stateReason: r.reason && !String(r.reason).startsWith('claim:') ? r.reason : null,
        // …and what the messaging engine / provider actually did.
        messageStatus: r.message_status || null,
        providerAccepted: Boolean(Number(r.provider_accepted)),
        sentAt: r.sent_at,
        deliveredAt: r.delivered_at,
        failedAt: r.failed_at,
        failureReason: r.last_error || r.suppressed_reason || null,
      })),
    };
  }

  async snapshotCounts(campaignId) {
    const rows = await query(
      `SELECT channel, state, COUNT(*) AS n FROM marketing_campaign_recipients
        WHERE campaign_id = ? GROUP BY channel, state`, [campaignId]);
    const out = { EMAIL: {}, WHATSAPP: {} };
    for (const r of rows) out[r.channel][r.state] = Number(r.n);
    return out;
  }

  suppressionReasons(campaignId) {
    return query(
      `SELECT channel, state, reason, COUNT(*) AS n FROM marketing_campaign_recipients
        WHERE campaign_id = ? AND reason IS NOT NULL AND reason NOT LIKE 'claim:%'
        GROUP BY channel, state, reason ORDER BY n DESC LIMIT 50`, [campaignId]);
  }

  /**
   * Delivery as the communications ENGINE sees it — the authoritative count.
   * The snapshot records what this module asked for; these rows record what
   * happened, including a suppression the engine applied at the send boundary
   * after we had already queued the message.
   */
  async delivery(campaignId) {
    const rows = await query(
      `SELECT channel, status, COUNT(*) AS n, attempt_count, suppressed_reason, last_error
         FROM communication_messages WHERE business_event_id LIKE ?
        GROUP BY channel, status, attempt_count, suppressed_reason, last_error`,
      [`${campaignEventPrefix(campaignId)}%`]);
    return rows.map((r) => ({ ...r, n: Number(r.n) }));
  }
}

export const marketingCampaignRepository = new MarketingCampaignRepository();
