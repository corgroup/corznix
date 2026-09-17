import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';
import { WORKFLOW_KEYS, workflowWhere } from './workflowBuckets.js';

const exec = async (connection, sql, params = []) =>
  (connection ? await connection.execute(sql, params) : [await query(sql, params)])[0];

// Data access for the order-operations surface: order confirmation / processing,
// shipment booking attempts, and normalised shipment events.
export class OrderOpsRepository {
  // ---- orders ------------------------------------------------------------
  lockOrder(connection, orderId) {
    return exec(connection, 'SELECT * FROM orders WHERE id=? OR order_number=? LIMIT 1 FOR UPDATE', [orderId, orderId]).then((r) => r[0] || null);
  }

  /**
   * One short line naming what the customer bought, for the order_management
   * WhatsApp template's {{itemsSummary}} slot — "Cotton Shirt (M) x2" for a
   * single line, "Cotton Shirt (M) x2 and 2 more" beyond that. Kept to three
   * rows because the approved template renders it inline in a sentence.
   */
  async itemsSummary(connection, orderId) {
    const rows = await exec(
      connection,
      'SELECT product_name, selected_size, quantity FROM order_items WHERE order_id=? ORDER BY created_at, id',
      [orderId],
    );
    if (!rows.length) return null;
    const label = (r) => `${r.product_name}${r.selected_size ? ` (${r.selected_size})` : ''}${Number(r.quantity) > 1 ? ` x${r.quantity}` : ''}`;
    const [first] = rows;
    return rows.length === 1 ? label(first) : `${label(first)} and ${rows.length - 1} more`;
  }

  // Phase 6 security pass (DESIGN.md §5.3) — brandId is optional only for
  // internal/system callers with no request context (order confirmation
  // cascades, the logistics completion bridge — every step there already
  // reached the order through an already brand-checked entry point); every
  // real HTTP route passes req.brandId so a cross-brand id 404s here
  // directly rather than relying on a check further downstream.
  order(orderId, brandId = null) {
    const brandClause = brandId ? ' AND brand_id = ?' : '';
    const params = brandId ? [orderId, orderId, brandId] : [orderId, orderId];
    return query(`SELECT * FROM orders WHERE (id=? OR order_number=?)${brandClause} LIMIT 1`, params).then((r) => r[0] || null);
  }

  // WP-16 — order search + warehouse-scoped filtering, shared by list + count.
  // Phase 5 — additive optional filters: paymentStatus / fulfillmentStatus /
  // placed date range. All default to null → no behaviour change when unset.
  // Phase 6 — brandId is the FIRST filter applied; every other filter/scope
  // narrows within it.
  #ordersWhere({ status = null, paymentStatus = null, fulfillmentStatus = null, placedFrom = null, placedTo = null, q = null, warehouseIds = null, brandId = null, workflow = null } = {}) {
    const where = [];
    const params = [];
    if (brandId) { where.push('o.brand_id = ?'); params.push(brandId); }
    if (status) { where.push('o.order_status = ?'); params.push(status); }
    // A workflow bucket is a fixed, code-defined predicate — never user text.
    const bucket = workflow ? workflowWhere(workflow) : null;
    if (bucket) where.push(bucket);
    if (paymentStatus) { where.push('o.payment_status = ?'); params.push(paymentStatus); }
    if (fulfillmentStatus) { where.push('o.fulfillment_status = ?'); params.push(fulfillmentStatus); }
    if (placedFrom) { where.push('o.placed_at >= ?'); params.push(`${placedFrom} 00:00:00`); }
    if (placedTo) { where.push('o.placed_at <= ?'); params.push(`${placedTo} 23:59:59.999`); }
    if (q) {
      const like = `%${q}%`;
      where.push(`(o.order_number LIKE ?
        OR EXISTS (SELECT 1 FROM customers c WHERE c.id = o.customer_id
          AND (CONCAT_WS(' ', c.first_name, c.last_name) LIKE ?
            OR EXISTS (SELECT 1 FROM customer_contacts cc WHERE cc.customer_id = c.id AND cc.normalized_value LIKE ?))))`);
      params.push(like, like, like);
    }
    if (warehouseIds && warehouseIds.length) {
      const ph = warehouseIds.map(() => '?').join(',');
      // A scoped staff member sees an order if any of its reservation lines
      // (pre-confirmation) OR any of its fulfilments (post-confirmation) is in
      // one of their warehouses.
      where.push(`(EXISTS (SELECT 1 FROM inventory_reservation_items ri
                     WHERE ri.reservation_id = o.inventory_reservation_id AND ri.warehouse_id IN (${ph}))
                 OR EXISTS (SELECT 1 FROM fulfillments f WHERE f.order_id = o.id AND f.warehouse_id IN (${ph})))`);
      params.push(...warehouseIds, ...warehouseIds);
    }
    return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  listOrders(filter = {}) {
    const { clause, params } = this.#ordersWhere(filter);
    const safeLimit = Math.min(Math.max(Number(filter.limit) || 50, 1), 200);
    const safeOffset = Math.max(Number(filter.offset) || 0, 0);
    return query(
      `SELECT o.id, o.order_number, o.customer_id, o.order_status, o.payment_status, o.payment_mode,
              o.fulfillment_status, o.total_minor, o.cod_due_minor, o.currency, o.placed_at, o.confirmed_at, o.processing_started_at,
              CONCAT_WS(' ', c.first_name, c.last_name) AS customer_name,
              (SELECT normalized_value FROM customer_contacts cc WHERE cc.customer_id = c.id AND cc.contact_type = 'EMAIL' AND cc.is_verified = 1 LIMIT 1) AS customer_email,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count,
              (SELECT COUNT(*) FROM fulfillments f WHERE f.order_id = o.id) AS fulfillment_count,
              (SELECT COUNT(*) FROM fulfillments f WHERE f.order_id = o.id AND f.status IN ('FULFILLED','PARTIALLY_FULFILLED')) AS fulfillment_done_count,
              (SELECT COUNT(*) FROM shipments s JOIN fulfillments f ON f.id = s.fulfillment_id WHERE f.order_id = o.id) AS shipment_count,
              (SELECT COUNT(*) FROM shipments s JOIN fulfillments f ON f.id = s.fulfillment_id WHERE f.order_id = o.id AND s.booking_status = 'BOOKED') AS shipment_booked_count,
              (SELECT COUNT(*) FROM shipments s JOIN fulfillments f ON f.id = s.fulfillment_id
                WHERE f.order_id = o.id AND s.status NOT IN ('CANCELLED','FAILED','LOST')) AS shipment_live_count,
              (SELECT COUNT(*) FROM shipments s JOIN fulfillments f ON f.id = s.fulfillment_id
                WHERE f.order_id = o.id AND s.status NOT IN ('CANCELLED','FAILED','LOST') AND s.label_status = 'AVAILABLE') AS shipment_label_ready_count,
              (SELECT COUNT(*) FROM shipments s JOIN fulfillments f ON f.id = s.fulfillment_id
                WHERE f.order_id = o.id AND s.status NOT IN ('CANCELLED','FAILED','LOST') AND s.pickup_requested_at IS NOT NULL) AS shipment_pickup_count,
              (SELECT COUNT(*) FROM shipments s JOIN fulfillments f ON f.id = s.fulfillment_id
                WHERE f.order_id = o.id AND s.status IN ('PICKED_UP','IN_TRANSIT')) AS shipment_transit_count,
              (SELECT COUNT(*) FROM shipments s JOIN fulfillments f ON f.id = s.fulfillment_id
                WHERE f.order_id = o.id AND s.status = 'OUT_FOR_DELIVERY') AS shipment_ofd_count,
              (SELECT COUNT(*) FROM shipments s JOIN fulfillments f ON f.id = s.fulfillment_id
                WHERE f.order_id = o.id AND s.status = 'DELIVERED') AS shipment_delivered_count,
              (SELECT COUNT(*) FROM shipments s JOIN fulfillments f ON f.id = s.fulfillment_id
                WHERE f.order_id = o.id AND s.booking_status = 'UNKNOWN') AS shipment_unknown_count
         FROM orders o JOIN customers c ON c.id = o.customer_id
        ${clause} ORDER BY o.placed_at DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`, params);
  }

  async countOrders(filter = {}) {
    const { clause, params } = this.#ordersWhere(filter);
    const rows = await query(`SELECT COUNT(*) AS n FROM orders o ${clause}`, params);
    return Number(rows[0].n);
  }

  // Phase 5 — insight-strip facets for the Orders workbench. Warehouse-scoped
  // like the list. `needsAction` = PLACED (awaiting confirmation) + CONFIRMED
  // (awaiting processing). `codDueMinor` = SUM over non-cancelled orders.
  async facets(scope = {}) {
    const { clause, params } = this.#ordersWhere({ warehouseIds: scope.warehouseIds || null, brandId: scope.brandId || null });
    const rows = await query(
      `SELECT o.order_status AS status, COUNT(*) AS n,
              SUM(CASE WHEN o.order_status <> 'CANCELLED' THEN o.cod_due_minor ELSE 0 END) AS cod_due,
              SUM(CASE WHEN o.order_status <> 'CANCELLED' THEN o.total_minor ELSE 0 END) AS gross_value
         FROM orders o ${clause} GROUP BY o.order_status`, params);
    const byStatus = { PLACED: 0, CONFIRMED: 0, PROCESSING: 0, COMPLETED: 0, CANCELLED: 0 };
    let total = 0; let codDue = 0; let gross = 0; let liveCount = 0;
    for (const r of rows) {
      byStatus[r.status] = Number(r.n);
      total += Number(r.n);
      codDue += Number(r.cod_due || 0);
      gross += Number(r.gross_value || 0);
      if (r.status !== 'CANCELLED') liveCount += Number(r.n);
    }
    return {
      total,
      byStatus,
      needsAction: byStatus.PLACED + byStatus.CONFIRMED,
      processing: byStatus.PROCESSING,
      completed: byStatus.COMPLETED,
      cancelled: byStatus.CANCELLED,
      codDueMinor: codDue,
      grossValueMinor: gross,
      avgValueMinor: liveCount ? Math.round(gross / liveCount) : 0,
    };
  }

  /**
   * Counts for the workflow tabs. Each uses the bucket's own predicate, so a
   * badge can never disagree with what the tab then shows.
   */
  async workflowCounts(scope = {}) {
    const out = {};
    for (const key of WORKFLOW_KEYS) {
      const { clause, params } = this.#ordersWhere({
        warehouseIds: scope.warehouseIds || null, brandId: scope.brandId || null, workflow: key,
      });
      // eslint-disable-next-line no-await-in-loop
      const rows = await query(`SELECT COUNT(*) AS n FROM orders o ${clause}`, params);
      out[key] = Number(rows[0].n);
    }
    return out;
  }

  // Phase 5 — order line items for the CMS detail page (additive read).
  // Joins the CURRENT product/variant for a live thumbnail + editor link;
  // falls back to the immutable snapshot fields when the product is gone.
  itemsForOrder(orderId) {
    return query(
      `SELECT oi.id, oi.product_id, oi.variant_id, oi.sku_id,
              oi.product_name, oi.sku, oi.selected_size, oi.selected_color,
              oi.quantity, oi.unit_price_minor, oi.line_total_minor, oi.media_snapshot,
              p.slug AS product_slug, p.status AS product_status,
              -- media_type = 'IMAGE': a GRADIENT row holds a CSS gradient string in
              -- the url column, and this column is rendered as a photo.
              (SELECT pm.url FROM product_media pm WHERE pm.product_id = oi.product_id AND pm.status = 'ACTIVE'
                 AND pm.media_type = 'IMAGE'
                ORDER BY pm.is_primary DESC, pm.position ASC LIMIT 1) AS current_image_url
         FROM order_items oi
         LEFT JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = ? ORDER BY oi.created_at, oi.id`, [orderId]);
  }

  // Phase 5 — applied-promotion snapshot (immutable) for the totals block.
  discountsForOrder(orderId) {
    return query(
      `SELECT id, promotion_id, coupon_code, discount_type, discount_scope,
              discount_total_minor
         FROM order_discounts WHERE order_id = ? ORDER BY created_at`, [orderId]);
  }

  /** Customer identity + verified contacts for the CMS Order detail panel (WP-16). */
  customerForOrder(customerId) {
    return query(
      `SELECT c.id, c.first_name, c.last_name,
              (SELECT normalized_value FROM customer_contacts cc WHERE cc.customer_id = c.id AND cc.contact_type = 'EMAIL' AND cc.is_verified = 1 LIMIT 1) AS verified_email,
              (SELECT normalized_value FROM customer_contacts cc WHERE cc.customer_id = c.id AND cc.contact_type = 'PHONE' AND cc.is_verified = 1 LIMIT 1) AS verified_phone
         FROM customers c WHERE c.id = ? LIMIT 1`, [customerId]).then((r) => r[0] || null);
  }

  /** Consumed reservation lines for an order, as the canonical allocation. */
  reservationLines(connection, orderId) {
    return exec(connection,
      `SELECT ri.warehouse_id, ri.sku_id, ri.quantity
         FROM orders o JOIN inventory_reservation_items ri ON ri.reservation_id = o.inventory_reservation_id
        WHERE o.id = ? ORDER BY ri.warehouse_id, ri.sku_id`, [orderId]);
  }

  setOrderStatus(connection, orderId, status, extra = {}) {
    const sets = ['order_status = ?', 'updated_at = NOW(3)'];
    const params = [status];
    for (const [col, val] of Object.entries(extra)) { sets.push(`${col} = ?`); params.push(val); }
    params.push(orderId);
    return exec(connection, `UPDATE orders SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  // ---- shipments -------------------------------------------------------
  lockShipment(connection, shipmentId) {
    return exec(connection,
      `SELECT s.*, f.order_id, f.status AS fulfillment_status, f.warehouse_snapshot_json, f.shipping_address_snapshot_json
         FROM shipments s JOIN fulfillments f ON f.id = s.fulfillment_id
        WHERE s.id = ? LIMIT 1 FOR UPDATE`, [shipmentId]).then((r) => r[0] || null);
  }

  shipment(shipmentId) {
    return query('SELECT * FROM shipments WHERE id = ? LIMIT 1', [shipmentId]).then((r) => r[0] || null);
  }

  updateShipment(connection, shipmentId, fields) {
    const sets = ['updated_at = NOW(3)'];
    const params = [];
    for (const [col, val] of Object.entries(fields)) { sets.push(`${col} = ?`); params.push(val); }
    params.push(shipmentId);
    return exec(connection, `UPDATE shipments SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  fulfillmentIds(orderId) {
    return query("SELECT id, fulfillment_number FROM fulfillments WHERE order_id = ? AND fulfillment_type = 'INITIAL' ORDER BY sequence", [orderId]);
  }

  shipmentsForOrder(orderId) {
    return query(
      `SELECT s.*, f.warehouse_id, f.status AS fulfillment_status
         FROM shipments s JOIN fulfillments f ON f.id = s.fulfillment_id
        WHERE f.order_id = ? ORDER BY f.sequence, s.sequence`, [orderId]);
  }

  orderForShipment(shipmentId) {
    return query(
      `SELECT o.* FROM shipments s JOIN fulfillments f ON f.id = s.fulfillment_id JOIN orders o ON o.id = f.order_id
        WHERE s.id = ? LIMIT 1`, [shipmentId]).then((r) => r[0] || null);
  }

  /**
   * Resolve a shipment by its provider tracking number (AWB) — the only
   * identifier an inbound carrier scan carries. `providerCode` narrows the
   * match so two providers can never collide on a coincidentally-equal AWB
   * string (Wave 8L / WP-01).
   */
  shipmentByTrackingNumber(trackingNumber, providerCode = null) {
    const where = providerCode ? 'WHERE s.tracking_number = ? AND s.provider_code = ?' : 'WHERE s.tracking_number = ?';
    const params = providerCode ? [trackingNumber, providerCode] : [trackingNumber];
    return query(
      // shipping_address_snapshot and the EDD are selected for the webhook
      // applier's notification context: every approved WhatsApp template opens
      // with the customer's name, and the message must go to the contact given
      // for THIS order rather than a profile default.
      `SELECT s.id, s.status, s.fulfillment_id,
              f.order_id, o.customer_id, o.order_number,
              o.shipping_address_snapshot, o.shipping_snapshot
         FROM shipments s
         JOIN fulfillments f ON f.id = s.fulfillment_id
         JOIN orders o ON o.id = f.order_id
        ${where} LIMIT 1`, params).then((r) => r[0] || null);
  }

  // ---- booking attempts ----------------------------------------------
  attemptByKey(connection, key) {
    return exec(connection, 'SELECT * FROM shipment_booking_attempts WHERE idempotency_key = ? LIMIT 1', [key]).then((r) => r[0] || null);
  }

  async createAttempt(connection, { shipmentId, providerCode, idempotencyKey, requestHash }) {
    const id = randomUUID();
    await exec(connection,
      `INSERT INTO shipment_booking_attempts (id, shipment_id, provider_code, idempotency_key, request_hash, status)
       VALUES (?, ?, ?, ?, ?, 'PENDING')`, [id, shipmentId, providerCode, idempotencyKey, requestHash]);
    return exec(connection, 'SELECT * FROM shipment_booking_attempts WHERE id = ?', [id]).then((r) => r[0]);
  }

  completeAttempt(connection, id, { status, providerShipmentId = null, trackingNumber = null, failureCode = null, response = null }) {
    return exec(connection,
      `UPDATE shipment_booking_attempts
          SET status = ?, provider_shipment_id = ?, tracking_number = ?, failure_code = ?, response_json = ?, completed_at = NOW(3)
        WHERE id = ?`,
      [status, providerShipmentId, trackingNumber, failureCode, response ? JSON.stringify(response) : null, id]);
  }

  // Phase 2 — auto-fulfilment state (see autoFulfillmentService). Column-mapped.
  setAutoFulfillment(shipmentId, patch) {
    const map = {
      status: 'auto_fulfillment_status', step: 'auto_fulfillment_step', error: 'auto_fulfillment_error',
      attempts: 'auto_fulfillment_attempts', nextAt: 'auto_fulfillment_next_at',
    };
    const cols = Object.keys(patch).filter((k) => k in map && patch[k] !== undefined);
    if (!cols.length) return Promise.resolve();
    return query(
      `UPDATE shipments SET ${cols.map((k) => `${map[k]} = ?`).join(', ')}, auto_fulfillment_updated_at = NOW(3) WHERE id = ?`,
      [...cols.map((k) => patch[k]), shipmentId],
    );
  }

  // Phase 2 · Slice 8 — the resolved per-item shipping weight for a shipment's
  // fulfilment: SKU override -> product default -> null (matches
  // adminCatalog.effectiveWeightGrams). NULL means "no weight configured".
  packageItemsForShipment(shipmentId) {
    return query(
      `SELECT fi.sku_id AS skuId, fi.quantity AS quantity,
              COALESCE(s.weight_grams, psp.weight_grams) AS effective_weight_grams
         FROM shipments sh
         JOIN fulfillment_items fi ON fi.fulfillment_id = sh.fulfillment_id
         JOIN skus s ON s.id = fi.sku_id
         JOIN product_variants v ON v.id = s.variant_id
         LEFT JOIN product_shipping_profiles psp ON psp.product_id = v.product_id
        WHERE sh.id = ?`,
      [shipmentId],
    );
  }

  // ---- shipment events ---------------------------------------------
  eventByKey(connection, providerCode, providerEventKey) {
    return exec(connection,
      'SELECT * FROM shipment_events WHERE provider_code = ? AND provider_event_key = ? LIMIT 1',
      [providerCode, providerEventKey]).then((r) => r[0] || null);
  }

  async insertEvent(connection, e) {
    const id = randomUUID();
    await exec(connection,
      `INSERT INTO shipment_events
        (id, shipment_id, source, provider_code, provider_event_key, provider_status, status_type, nsl_code,
         normalized_status, occurred_at, location_text, remarks, applied)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, e.shipmentId, e.source || 'MOCK', e.providerCode, e.providerEventKey, e.providerStatus || null,
        e.statusType || null, e.nslCode || null,
        e.normalizedStatus, e.occurredAt, e.locationText || null, e.remarks || null, e.applied ? 1 : 0]);
    return id;
  }

  events(shipmentId) {
    return query(
      `SELECT source, provider_status, normalized_status, occurred_at, location_text, remarks, applied
         FROM shipment_events WHERE shipment_id = ? ORDER BY occurred_at, received_at`, [shipmentId]);
  }

  // Phase 5 — order-level timeline (additive read; no new table). Composes:
  //  - order lifecycle timestamps (orders.*_at)
  //  - shipment_events for every shipment on the order
  //  - staff_audit_logs whose resource is the order or one of its shipments
  //  - return request events for returns linked to the order
  async timelineForOrder(orderId) {
    const order = await this.order(orderId);
    if (!order) return [];
    const oid = order.id;
    const [shipmentRows, auditRows, returnRows] = await Promise.all([
      query(
        `SELECT s.id, s.shipment_number,
                se.source, se.normalized_status, se.provider_status, se.occurred_at, se.location_text, se.remarks
           FROM shipments s
           JOIN fulfillments f ON f.id = s.fulfillment_id
           LEFT JOIN shipment_events se ON se.shipment_id = s.id
          WHERE f.order_id = ?`, [oid]),
      query(
        `SELECT l.created_at, l.action, l.resource_type, l.resource_id, l.metadata_json,
                CONCAT_WS(' ', su.first_name, su.last_name) AS staff_name, l.actor_email
           FROM staff_audit_logs l
           LEFT JOIN staff_users su ON su.id = l.staff_user_id
          WHERE (l.resource_type = 'order' AND l.resource_id = ?)
             OR (l.resource_type IN ('shipment', 'invoice', 'fulfillment')
                 AND l.resource_id IN (
                   SELECT s.id FROM shipments s JOIN fulfillments f ON f.id = s.fulfillment_id WHERE f.order_id = ?
                   UNION SELECT f.id FROM fulfillments f WHERE f.order_id = ?
                   UNION SELECT i.id FROM invoices i WHERE i.order_id = ?
                 ))
          ORDER BY l.created_at`,
        [oid, oid, oid, oid],
      ).catch(() => []),
      query(
        `SELECT rr.request_number, rre.event_type, rre.to_status, rre.created_at, rre.actor_type
           FROM return_requests rr
           JOIN return_request_events rre ON rre.return_request_id = rr.id
          WHERE rr.order_id = ? ORDER BY rre.created_at`, [oid],
      ).catch(() => []),
    ]);

    const events = [];
    const push = (at, category, title, detail = null, actor = null) => {
      if (!at) return;
      events.push({ at: new Date(at).toISOString(), category, title, detail, actor });
    };

    push(order.placed_at, 'ORDER', 'Order placed', `${order.payment_mode} · ${order.payment_status}`);
    push(order.confirmed_at, 'ORDER', 'Order confirmed', 'Allocation confirmed; eligible for fulfilment');
    push(order.processing_started_at, 'ORDER', 'Processing started');
    push(order.completed_at, 'ORDER', 'Order completed', 'All parcels delivered');
    push(order.cancelled_at, 'ORDER', 'Order cancelled', order.cancellation_reason || null);

    const shipByNumber = new Map();
    for (const r of shipmentRows) {
      if (!r.normalized_status) continue;
      shipByNumber.set(r.shipment_number, true);
      push(
        r.occurred_at, 'SHIPMENT',
        `${r.shipment_number}: ${String(r.normalized_status).replace(/_/g, ' ').toLowerCase()}`,
        [r.location_text, r.remarks].filter(Boolean).join(' · ') || null,
        r.source === 'WEBHOOK' ? 'carrier' : (r.source || null),
      );
    }

    // These audit actions are already emitted from the order lifecycle
    // timestamps above — skip so the timeline shows each milestone once.
    const COVERED = new Set(['ORDER_CONFIRMED', 'ORDER_PROCESSING_STARTED', 'ORDER_CANCELLED', 'ORDER_PLACED', 'ORDER_COMPLETED']);
    for (const a of auditRows) {
      if (COVERED.has(a.action)) continue;
      push(
        a.created_at, a.resource_type === 'order' ? 'ORDER' : 'SHIPMENT',
        String(a.action).replace(/_/g, ' ').toLowerCase().replace(/\b\w/, (c) => c.toUpperCase()),
        null,
        a.staff_name?.trim() || a.actor_email || 'system',
      );
    }

    for (const r of returnRows) {
      push(
        r.created_at, 'RETURN',
        `${r.request_number}: ${String(r.event_type || r.to_status || 'update').replace(/_/g, ' ').toLowerCase()}`,
        null,
        r.actor_type ? String(r.actor_type).toLowerCase() : null,
      );
    }

    return events.sort((x, y) => new Date(x.at) - new Date(y.at));
  }

  /**
   * The dispatch origins for an order, with the full postal address and the
   * pickup contact. This is the "Ship From" block a carrier label must print
   * in full, and the number a pickup agent calls — so it is read from the
   * live warehouse record, not from a snapshot that may predate a correction.
   */
  warehousesByIds(ids) {
    if (!Array.isArray(ids) || !ids.length) return Promise.resolve([]);
    const placeholders = ids.map(() => '?').join(',');
    return query(
      `SELECT id, code, name, address_line1, address_line2, city, state, postal_code, country,
              contact_name, contact_phone, contact_phone_alt, contact_email, status
         FROM warehouses WHERE id IN (${placeholders})`, ids,
    );
  }

  /**
   * The order-line + seller facts Delhivery prints on the shipping label.
   *
   * Read from the ORDER-ITEM SNAPSHOT and the issued invoice, never the live
   * catalogue: a product's name, SKU or price can change after the customer
   * bought it, and the label must show what was actually sold. HSN comes from
   * the tax profile the invoice was issued under.
   */
  async labelFactsForOrder(orderId) {
    const [items, invoice, hsn] = await Promise.all([
      query(
        `SELECT oi.product_name, oi.sku, oi.selected_size, oi.selected_color, oi.quantity
           FROM order_items oi WHERE oi.order_id = ? ORDER BY oi.created_at, oi.id`, [orderId]),
      query('SELECT invoice_number, supplier_snapshot_json FROM invoices WHERE order_id = ? ORDER BY issued_at DESC LIMIT 1', [orderId])
        .then((r) => r[0] || null),
      query(
        `SELECT tp.hsn_sac FROM order_items oi
           JOIN product_tax_profiles ptp ON ptp.product_id = oi.product_id
           JOIN tax_profiles tp ON tp.id = ptp.tax_profile_id
          WHERE oi.order_id = ? AND tp.hsn_sac IS NOT NULL LIMIT 1`, [orderId]).catch(() => []),
    ]);
    return { items, invoice, hsnSac: hsn[0]?.hsn_sac || null };
  }

  // Phase 5 — returns / exchanges linked to an order (additive read).
  returnsForOrder(orderId) {
    return query(
      `SELECT rr.id, rr.request_number, rr.request_type, rr.status, rr.reason_code,
              rr.requested_at, rr.updated_at
         FROM return_requests rr
        WHERE rr.order_id = ? OR rr.order_id = (SELECT id FROM orders WHERE order_number = ? LIMIT 1)
        ORDER BY rr.requested_at DESC`, [orderId, orderId],
    );
  }
}

export const orderOpsRepository = new OrderOpsRepository();
