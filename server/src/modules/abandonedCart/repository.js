import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';

/**
 * Abandoned-cart campaigns are ordinary campaigns (docs/MESSAGING.md) whose
 * trigger is `cart.abandoned`. This maps a marketing_campaigns row and its
 * campaign_channels onto the shape the detector has always used, so the
 * once-per-episode, never-after-purchase and cooldown guarantees below are
 * unchanged.
 */
const campaignDto = (r, channels) => {
  const cfg = (typeof r.trigger_config === 'string' ? JSON.parse(r.trigger_config) : r.trigger_config) || {};
  const email = channels.find((c) => c.channel === 'EMAIL');
  const whatsapp = channels.find((c) => c.channel === 'WHATSAPP');
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    delayMinutes: Number(cfg.delayMinutes ?? 240),
    maxAgeHours: Number(cfg.maxAgeHours ?? 168),
    cooldownHours: Number(cfg.cooldownHours ?? 168),
    emailEnabled: Boolean(email),
    whatsappEnabled: Boolean(whatsapp),
    emailTemplateKey: email?.template_key ?? null,
    whatsappTemplateKey: whatsapp?.template_key ?? null,
    minCartValueMinor: Number(cfg.minCartValueMinor ?? 0),
    couponCode: cfg.couponCode ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
};

async function withChannels(rows) {
  if (!rows.length) return [];
  const channels = await query(
    `SELECT campaign_id, channel, template_key FROM campaign_channels
      WHERE campaign_id IN (${rows.map(() => '?').join(',')})`, rows.map((r) => r.id));
  return rows.map((r) => campaignDto(r, channels.filter((c) => c.campaign_id === r.id)));
}

export class AbandonedCartRepository {
  async campaignById(id) {
    const rows = await query(
      "SELECT * FROM marketing_campaigns WHERE id = ? AND trigger_type = 'EVENT' AND trigger_event = 'cart.abandoned' LIMIT 1", [id]);
    return (await withChannels(rows))[0] || null;
  }

  async activeCampaignsRaw() {
    return withChannels(await query(
      "SELECT * FROM marketing_campaigns WHERE status = 'ACTIVE' AND trigger_type = 'EVENT' AND trigger_event = 'cart.abandoned'"));
  }

  /**
   * Carts eligible for `campaign` right now. Every guarantee is enforced here
   * in one query so a race in the service layer can never widen it:
   *   - the cart has at least one item and is stale by >= delay but younger
   *     than max_age (a truly dead cart is not worth a reminder);
   *   - NO order placed by that customer at/after the cart's last activity
   *     (the "never after a purchase" rule);
   *   - this campaign has not already reminded this exact cart episode
   *     (carts.updated_at unchanged since the last send → UNIQUE key would
   *     reject it anyway; excluded here so it never even renders);
   *   - the customer has not been reminded by ANY campaign within cooldown_hours.
   * The live subtotal / min-cart-value check is done in the service against the
   * canonical cart pricing (price is deliberately not on cart_items).
   */
  // `customerIds` narrows a scan to named customers (the verify gate's own
  // fixtures) so a test can never remind a real customer; null = everyone.
  candidateCarts(campaign, { limit = 50, customerIds = null } = {}) {
    const only = Array.isArray(customerIds);
    if (only && !customerIds.length) return Promise.resolve([]);
    return query(
      `SELECT c.id AS cart_id, c.customer_id, c.updated_at AS cart_activity_at
         FROM carts c
        WHERE c.updated_at <= DATE_SUB(NOW(3), INTERVAL ? MINUTE)
          AND c.updated_at >= DATE_SUB(NOW(3), INTERVAL ? HOUR)
          AND EXISTS (SELECT 1 FROM cart_items ci WHERE ci.cart_id = c.id)
          AND NOT EXISTS (
                SELECT 1 FROM orders o
                 WHERE o.customer_id = c.customer_id AND o.placed_at >= c.updated_at)
          AND NOT EXISTS (
                SELECT 1 FROM abandoned_cart_sends s
                 WHERE s.campaign_id = ? AND s.cart_id = c.id
                   AND s.cart_activity_at = c.updated_at)
          AND NOT EXISTS (
                SELECT 1 FROM abandoned_cart_sends s2
                 WHERE s2.customer_id = c.customer_id
                   AND s2.created_at >= DATE_SUB(NOW(3), INTERVAL ? HOUR))
          ${only ? `AND c.customer_id IN (${customerIds.map(() => '?').join(',')})` : ''}
        ORDER BY c.updated_at ASC
        LIMIT ?`,
      [campaign.delayMinutes, campaign.maxAgeHours, campaign.id, campaign.cooldownHours, ...(only ? customerIds : []), limit]);
  }

  /**
   * Idempotent record of a reminder. The UNIQUE key (campaign_id, cart_id,
   * cart_activity_at) is the real "send once per episode" guarantee — a
   * concurrent worker tick that already inserted this row makes affectedRows 0
   * and we return { created: false } without enqueuing anything.
   */
  async recordSend({ campaignId, cartId, customerId, cartActivityAt, cartSubtotalMinor, channels, businessEventId }) {
    const id = randomUUID();
    const res = await query(
      `INSERT IGNORE INTO abandoned_cart_sends
        (id, campaign_id, cart_id, customer_id, cart_activity_at, cart_subtotal_minor, channels_enqueued, business_event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, campaignId, cartId, customerId, cartActivityAt, cartSubtotalMinor, channels.join(','), businessEventId]);
    return { created: res.affectedRows > 0, id };
  }

  /**
   * Every reminder actually sent, one row per cart episode, newest first —
   * what the Cart Recovery page lists under its totals. Each channel's real
   * message (status, provider acceptance, send / delivery / failure time,
   * failure reason) is attached separately, so a reminder that went on both
   * Email and WhatsApp shows both. Test reminders are not episodes and are
   * not listed. "Recovered" = an order (not cancelled) by that customer
   * within `attributionHours` of the reminder.
   */
  async reminderLog({ campaignIds = null, limit = 50, offset = 0, attributionHours = 72 } = {}) {
    const where = campaignIds?.length ? `WHERE s.campaign_id IN (${campaignIds.map(() => '?').join(',')})` : '';
    const params = campaignIds?.length ? campaignIds : [];
    const [rows, [{ total }]] = await Promise.all([
      query(
        `SELECT s.id, s.campaign_id, mc.name AS campaign_name, s.customer_id, s.cart_id,
                s.cart_subtotal_minor, s.cart_activity_at, s.channels_enqueued, s.business_event_id, s.created_at,
                TRIM(CONCAT(COALESCE(cu.first_name, ''), ' ', COALESCE(cu.last_name, ''))) AS customer_name,
                (SELECT cc.normalized_value FROM customer_contacts cc
                  WHERE cc.customer_id = s.customer_id AND cc.contact_type = 'EMAIL' ORDER BY cc.is_verified DESC LIMIT 1) AS email,
                (SELECT cc.normalized_value FROM customer_contacts cc
                  WHERE cc.customer_id = s.customer_id AND cc.contact_type = 'PHONE' ORDER BY cc.is_verified DESC LIMIT 1) AS phone,
                (SELECT JSON_OBJECT('id', o.id, 'orderNumber', o.order_number, 'totalMinor', o.total_minor, 'placedAt', o.placed_at)
                   FROM orders o
                  WHERE o.customer_id = s.customer_id AND o.order_status <> 'CANCELLED'
                    AND o.placed_at >= s.created_at AND o.placed_at <= DATE_ADD(s.created_at, INTERVAL ? HOUR)
                  ORDER BY o.placed_at ASC LIMIT 1) AS recovered_order
           FROM abandoned_cart_sends s
           JOIN marketing_campaigns mc ON mc.id = s.campaign_id
           LEFT JOIN customers cu ON cu.id = s.customer_id
           ${where}
          ORDER BY s.created_at DESC
          LIMIT ? OFFSET ?`, [attributionHours, ...params, limit, offset]),
      query(`SELECT COUNT(*) AS total FROM abandoned_cart_sends s ${where}`, params),
    ]);
    const events = rows.map((r) => r.business_event_id);
    const messages = events.length ? await query(
      `SELECT business_event_id, channel, status, recipient_contact_key, provider_message_id IS NOT NULL AS provider_accepted,
              sent_at, delivered_at, failed_at, last_error, suppressed_reason, created_at, variables_json
         FROM communication_messages WHERE business_event_id IN (${events.map(() => '?').join(',')})
        ORDER BY channel`, events) : [];
    const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
    return {
      total: Number(total),
      reminders: rows.map((r) => {
        const own = messages.filter((m) => m.business_event_id === r.business_event_id);
        const vars = parse(own[0]?.variables_json) || {};
        return {
          id: r.id,
          campaignId: r.campaign_id,
          campaignName: r.campaign_name,
          customerId: r.customer_id,
          customerName: r.customer_name || null,
          email: r.email || null,
          phone: r.phone || null,
          cart: {
            subtotalMinor: Number(r.cart_subtotal_minor),
            itemCount: vars.itemCount ?? null,
            leadProduct: vars.productName || null,
            leadVariant: vars.variantLabel || null,
            lastActivityAt: r.cart_activity_at,
          },
          reminderType: 'Abandoned cart reminder',
          sentAt: r.created_at,
          channels: own.map((m) => ({
            channel: m.channel,
            to: m.recipient_contact_key,
            status: m.status,
            providerAccepted: Boolean(Number(m.provider_accepted)),
            sentAt: m.sent_at,
            deliveredAt: m.delivered_at,
            failedAt: m.failed_at,
            reason: m.last_error || m.suppressed_reason || null,
          })),
          recoveredOrder: parse(r.recovered_order) || null,
        };
      }),
    };
  }

  /**
   * Campaign performance. "Converted" = the customer placed an order within
   * `attributionHours` of the reminder. Best-effort attribution for the CMS —
   * it is not a billing figure.
   */
  async campaignStats(campaignId, { attributionHours = 72 } = {}) {
    const rows = await query(
      `SELECT
         COUNT(*) AS reminders,
         COUNT(DISTINCT s.customer_id) AS customers,
         SUM(EXISTS (
           SELECT 1 FROM orders o
            WHERE o.customer_id = s.customer_id
              AND o.placed_at >= s.created_at
              AND o.placed_at <= DATE_ADD(s.created_at, INTERVAL ? HOUR)
         )) AS converted,
         COALESCE(SUM((
           SELECT COALESCE(SUM(o.total_minor), 0) FROM orders o
            WHERE o.customer_id = s.customer_id
              AND o.placed_at >= s.created_at
              AND o.placed_at <= DATE_ADD(s.created_at, INTERVAL ? HOUR)
              AND o.order_status <> 'CANCELLED'
         )), 0) AS recovered_minor,
         MAX(s.created_at) AS last_sent_at
       FROM abandoned_cart_sends s
       WHERE s.campaign_id = ?`,
      [attributionHours, attributionHours, campaignId]);
    const r = rows[0] || {};
    return {
      reminders: Number(r.reminders || 0),
      customers: Number(r.customers || 0),
      converted: Number(r.converted || 0),
      recoveredMinor: Number(r.recovered_minor || 0),
      lastSentAt: r.last_sent_at || null,
    };
  }
}

export const abandonedCartRepository = new AbandonedCartRepository();
