import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';

const exec = async (connection, sql, params = []) =>
  (connection ? (await connection.execute(sql, params))[0] : query(sql, params));

export class ReviewRepository {
  /**
   * Delivered order items belonging to `customerId` for `productId` that do
   * not yet have a review. Delivery is the shipment's `delivered_at` for the
   * fulfillment that shipped the item (§67).
   */
  eligibleOrderItems(customerId, productId) {
    return query(
      `SELECT oi.id AS order_item_id, oi.product_id, oi.variant_id, oi.product_name, oi.sku,
              o.order_number, MAX(sh.delivered_at) AS delivered_at
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         LEFT JOIN fulfillment_items fi ON fi.order_item_id = oi.id
         LEFT JOIN fulfillments f ON f.id = fi.fulfillment_id AND f.return_request_id IS NULL
         LEFT JOIN shipments sh ON sh.fulfillment_id = f.id
        WHERE o.customer_id = ? AND oi.product_id = ?
          AND NOT EXISTS (SELECT 1 FROM product_reviews pr WHERE pr.order_item_id = oi.id)
        GROUP BY oi.id, oi.product_id, oi.variant_id, oi.product_name, oi.sku, o.order_number
       HAVING delivered_at IS NOT NULL`,
      [customerId, productId]);
  }

  /** A single order item with its owning customer + authoritative delivery time. */
  orderItemForReview(connection, orderItemId) {
    return exec(connection,
      `SELECT oi.id AS order_item_id, oi.product_id, oi.variant_id, oi.product_name, oi.sku,
              o.customer_id, MAX(sh.delivered_at) AS delivered_at
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         LEFT JOIN fulfillment_items fi ON fi.order_item_id = oi.id
         LEFT JOIN fulfillments f ON f.id = fi.fulfillment_id AND f.return_request_id IS NULL
         LEFT JOIN shipments sh ON sh.fulfillment_id = f.id
        WHERE oi.id = ?
        GROUP BY oi.id, oi.product_id, oi.variant_id, oi.product_name, oi.sku, o.customer_id`,
      [orderItemId]).then((r) => r[0] || null);
  }

  async insertReview(connection, r) {
    const id = randomUUID();
    await exec(connection,
      `INSERT INTO product_reviews
        (id, customer_id, product_id, variant_id, order_item_id, rating, title, body, status, verified_purchase, product_snapshot_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 1, ?)`,
      [id, r.customerId, r.productId, r.variantId || null, r.orderItemId, r.rating, r.title || null, r.body,
        r.productSnapshot ? JSON.stringify(r.productSnapshot) : null]);
    return exec(connection, 'SELECT * FROM product_reviews WHERE id = ?', [id]).then((rows) => rows[0]);
  }

  reviewById(connection, id, { lock = false } = {}) {
    return exec(connection, `SELECT * FROM product_reviews WHERE id = ? LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [id])
      .then((r) => r[0] || null);
  }

  reviewByOrderItem(connection, orderItemId) {
    return exec(connection, 'SELECT * FROM product_reviews WHERE order_item_id = ? LIMIT 1', [orderItemId]).then((r) => r[0] || null);
  }

  /** Compare-and-set status transition — the moderation race resolver (§78). */
  async transitionStatus(connection, id, { fromVersion, toStatus, reason, staffId, publishedAt = null }) {
    const res = await exec(connection,
      `UPDATE product_reviews
          SET status = ?, status_version = status_version + 1,
              moderation_reason = ?, moderated_by_staff_id = ?, moderated_at = NOW(3),
              published_at = COALESCE(?, published_at), updated_at = NOW(3)
        WHERE id = ? AND status_version = ?`,
      [toStatus, reason || null, staffId || null, publishedAt, id, fromVersion]);
    return res.affectedRows === 1;
  }

  recordEvent(connection, reviewId, e) {
    return exec(connection,
      `INSERT INTO product_review_events (id, review_id, event_type, from_status, to_status, actor_type, actor_id, reason, detail_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), reviewId, e.eventType, e.fromStatus || null, e.toStatus || null,
        e.actorType || 'SYSTEM', e.actorId || null, e.reason || null, e.detail ? JSON.stringify(e.detail) : null]);
  }

  events(reviewId) {
    return query(
      'SELECT event_type, from_status, to_status, actor_type, reason, created_at FROM product_review_events WHERE review_id = ? ORDER BY created_at, id',
      [reviewId]);
  }

  publishedForProduct(productId, { limit = 20, offset = 0 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    return query(
      `SELECT r.id, r.rating, r.title, r.body, r.verified_purchase, r.published_at,
              c.first_name AS reviewer_first_name
         FROM product_reviews r JOIN customers c ON c.id = r.customer_id
        WHERE r.product_id = ? AND r.status = 'PUBLISHED'
        ORDER BY r.published_at DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`, [productId]);
  }

  // Published reviews across the catalogue, for the storefront's social-proof
  // section. Brand comes from the joined product because product_reviews has
  // no brand_id of its own, so one company's reviews can never surface on
  // another's storefront.
  publishedFeatured({ limit = 6, minRating = 4, brandId = null } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 6, 1), 24);
    const params = [Number(minRating) || 4];
    let brandClause = '';
    if (brandId) { brandClause = 'AND p.brand_id = ?'; params.push(brandId); }
    return query(
      `SELECT r.rating, r.title, r.body, r.verified_purchase, r.published_at,
              c.first_name AS reviewer_first_name, p.name AS product_name
         FROM product_reviews r
         JOIN customers c ON c.id = r.customer_id
         JOIN products p ON p.id = r.product_id
        WHERE r.status = 'PUBLISHED' AND r.rating >= ? ${brandClause}
        ORDER BY r.verified_purchase DESC, r.published_at DESC
        LIMIT ${safeLimit}`, params);
  }

  listByCustomer(customerId) {
    return query(
      `SELECT id, product_id, rating, title, body, status, created_at, published_at
         FROM product_reviews WHERE customer_id = ? ORDER BY created_at DESC`, [customerId]);
  }

  adminList({ status = null, productId = null, limit = 50, offset = 0 } = {}) {
    const where = [];
    const params = [];
    if (status) { where.push('r.status = ?'); params.push(status); }
    if (productId) { where.push('r.product_id = ?'); params.push(productId); }
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    return query(
      `SELECT r.id, r.customer_id, r.product_id, p.name AS product_name, r.rating, r.title, r.body,
              r.status, r.status_version, r.verified_purchase, r.moderation_reason, r.created_at
         FROM product_reviews r JOIN products p ON p.id = r.product_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY FIELD(r.status,'PENDING','HIDDEN','PUBLISHED','REJECTED'), r.created_at DESC
        LIMIT ${safeLimit} OFFSET ${safeOffset}`, params);
  }

  // ---- aggregate (single authoritative write, §76) ------------------
  recomputeAggregate(connection, productId) {
    return exec(connection,
      `INSERT INTO product_rating_aggregates (product_id, review_count, rating_sum, average_bps)
       SELECT * FROM (
         SELECT ? AS product_id, COUNT(*) AS review_count, COALESCE(SUM(rating), 0) AS rating_sum,
                CASE WHEN COUNT(*) = 0 THEN 0 ELSE ROUND(SUM(rating) * 10000 / COUNT(*)) END AS average_bps
           FROM product_reviews WHERE product_id = ? AND status = 'PUBLISHED'
       ) AS agg
       ON DUPLICATE KEY UPDATE
         review_count = agg.review_count, rating_sum = agg.rating_sum,
         average_bps = agg.average_bps, updated_at = NOW(3)`,
      [productId, productId]);
  }

  aggregate(productId) {
    return query('SELECT * FROM product_rating_aggregates WHERE product_id = ? LIMIT 1', [productId]).then((r) => r[0] || null);
  }

  allProductIdsWithReviews() {
    return query('SELECT DISTINCT product_id FROM product_reviews').then((rows) => rows.map((r) => r.product_id));
  }
}

export const reviewRepository = new ReviewRepository();
