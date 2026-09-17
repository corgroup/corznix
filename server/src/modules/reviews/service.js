import { withTransaction } from '../../database/connection/transaction.js';
import { AppError } from '../../utils/errors.js';
import { reviewRepository } from './repository.js';

/**
 * Customer + public product reviews (§65-79). "Verified purchase" is computed
 * here from a DELIVERED order item that belongs to the reviewing customer —
 * the client only sends an order item id, never a verification claim (§66).
 * A review is created PENDING; only a moderator publishes it (§71/§75).
 */
export class ReviewService {
  constructor({ repository = reviewRepository, transaction = withTransaction } = {}) {
    this.repository = repository;
    this.transaction = transaction;
  }

  async eligibility({ customerId, productId }) {
    const items = await this.repository.eligibleOrderItems(customerId, productId);
    return {
      productId,
      canReview: items.length > 0,
      eligibleOrderItems: items.map((i) => ({
        orderItemId: i.order_item_id, orderNumber: i.order_number,
        productName: i.product_name, deliveredAt: i.delivered_at,
      })),
    };
  }

  async submit({ customerId, orderItemId, rating, title = null, body }) {
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new AppError('VALIDATION_ERROR', 'Rating must be an integer between 1 and 5.', 400);
    }
    if (!body || body.trim().length < 3 || body.trim().length > 5000) {
      throw new AppError('VALIDATION_ERROR', 'A review body of 3-5000 characters is required.', 400);
    }

    return this.transaction(async (tx) => {
      const item = await this.repository.orderItemForReview(tx, orderItemId);
      if (!item) throw new AppError('ORDER_ITEM_NOT_FOUND', 'That purchase was not found.', 404);
      // Ownership + verified-purchase, both backend-computed (§66).
      if (item.customer_id !== customerId) throw new AppError('REVIEW_NOT_ELIGIBLE', 'You can only review your own purchases.', 403);
      if (!item.delivered_at) throw new AppError('REVIEW_NOT_ELIGIBLE', 'You can review this item once it has been delivered.', 409);

      const existing = await this.repository.reviewByOrderItem(tx, orderItemId);
      if (existing) throw new AppError('REVIEW_ALREADY_EXISTS', 'You have already reviewed this purchase.', 409);

      let review;
      try {
        review = await this.repository.insertReview(tx, {
          customerId, productId: item.product_id, variantId: item.variant_id, orderItemId,
          rating, title: title ? title.trim().slice(0, 160) : null, body: body.trim(),
          productSnapshot: { productName: item.product_name, sku: item.sku },
        });
      } catch (err) {
        // UNIQUE(order_item_id) — the concurrent-submission race resolver (§77).
        if (err.code === 'ER_DUP_ENTRY') throw new AppError('REVIEW_ALREADY_EXISTS', 'You have already reviewed this purchase.', 409);
        throw err;
      }
      await this.repository.recordEvent(tx, review.id, { eventType: 'REVIEW_SUBMITTED', toStatus: 'PENDING', actorType: 'CUSTOMER', actorId: customerId });
      return this.#customerDto(review);
    });
  }

  #customerDto(r) {
    return {
      id: r.id,
      productId: r.product_id,
      rating: Number(r.rating),
      title: r.title ?? null,
      body: r.body,
      status: r.status,
      verifiedPurchase: Boolean(r.verified_purchase),
      createdAt: r.created_at,
      publishedAt: r.published_at ?? null,
    };
  }

  async myReviews(customerId) {
    return (await this.repository.listByCustomer(customerId)).map((r) => this.#customerDto(r));
  }

  // ---- public PDP -------------------------------------------------
  async publicForProduct(productId, { limit = 20, offset = 0 } = {}) {
    const [rows, agg] = await Promise.all([
      this.repository.publishedForProduct(productId, { limit, offset }),
      this.repository.aggregate(productId),
    ]);
    return {
      summary: {
        count: agg ? Number(agg.review_count) : 0,
        average: agg && agg.review_count > 0 ? Number(agg.average_bps) / 10000 : null,
      },
      // Only PUBLISHED reviews are ever returned here (§75). Reviewer identity
      // is reduced to a first name.
      reviews: rows.map((r) => ({
        rating: Number(r.rating),
        title: r.title ?? null,
        body: r.body,
        verifiedPurchase: Boolean(r.verified_purchase),
        reviewer: r.reviewer_first_name || 'Verified buyer',
        publishedAt: r.published_at,
      })),
    };
  }

  // ---- public storefront social proof -------------------------------
  // The homepage's testimonial strip shipped three invented quotes with
  // invented names, hardcoded in the component. This returns real published
  // reviews instead, reduced to the same first-name-only identity the PDP
  // uses; an empty list is a real answer and the strip hides itself.
  async featured({ limit = 6, brandId = null } = {}) {
    const rows = await this.repository.publishedFeatured({ limit, brandId });
    return {
      reviews: rows.map((r) => ({
        rating: Number(r.rating),
        title: r.title ?? null,
        body: r.body,
        productName: r.product_name,
        verifiedPurchase: Boolean(r.verified_purchase),
        reviewer: r.reviewer_first_name || 'Verified buyer',
        publishedAt: r.published_at,
      })),
    };
  }
}

export const reviewService = new ReviewService();
