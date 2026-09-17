import { withTransaction } from '../../database/connection/transaction.js';
import { AppError } from '../../utils/errors.js';
import { reviewRepository } from './repository.js';

const parse = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);

// Allowed moderation transitions. Moderation NEVER edits the customer's text
// (§72) — only status + a reason.
const ACTIONS = Object.freeze({
  PUBLISH: { from: ['PENDING', 'REJECTED', 'HIDDEN'], to: 'PUBLISHED' },
  REJECT: { from: ['PENDING', 'PUBLISHED', 'HIDDEN'], to: 'REJECTED' },
  HIDE: { from: ['PUBLISHED'], to: 'HIDDEN' },
});

export class ReviewAdminService {
  constructor({ repository = reviewRepository, transaction = withTransaction } = {}) {
    this.repository = repository;
    this.transaction = transaction;
  }

  async list(filters) {
    const rows = await this.repository.adminList(filters);
    return rows.map((r) => ({
      id: r.id,
      customerId: r.customer_id,
      productId: r.product_id,
      productName: r.product_name,
      rating: Number(r.rating),
      title: r.title ?? null,
      body: r.body,
      status: r.status,
      statusVersion: Number(r.status_version),
      verifiedPurchase: Boolean(r.verified_purchase),
      moderationReason: r.moderation_reason ?? null,
      createdAt: r.created_at,
    }));
  }

  async detail(id) {
    const review = await this.repository.reviewById(null, id);
    if (!review) throw new AppError('REVIEW_NOT_FOUND', 'Review not found.', 404);
    return {
      id: review.id,
      customerId: review.customer_id,
      productId: review.product_id,
      rating: Number(review.rating),
      title: review.title ?? null,
      body: review.body,
      status: review.status,
      statusVersion: Number(review.status_version),
      verifiedPurchase: Boolean(review.verified_purchase),
      productSnapshot: parse(review.product_snapshot_json),
      moderationReason: review.moderation_reason ?? null,
      createdAt: review.created_at,
      publishedAt: review.published_at ?? null,
      events: (await this.repository.events(review.id)).map((e) => ({
        eventType: e.event_type, fromStatus: e.from_status ?? null, toStatus: e.to_status ?? null,
        actorType: e.actor_type, reason: e.reason ?? null, at: e.created_at,
      })),
    };
  }

  /**
   * Moderate one review with a compare-and-set on `status_version` — a
   * concurrent publish and reject cannot both apply (§78). The aggregate is
   * recomputed from PUBLISHED reviews inside the same transaction (§76).
   */
  async moderate({ reviewId, action, reason = null, expectedVersion, staffId }) {
    const spec = ACTIONS[action];
    if (!spec) throw new AppError('VALIDATION_ERROR', `Unknown moderation action "${action}".`, 400);
    if (!Number.isInteger(expectedVersion)) throw new AppError('VALIDATION_ERROR', 'expectedVersion is required.', 400);

    return this.transaction(async (tx) => {
      const review = await this.repository.reviewById(tx, reviewId, { lock: true });
      if (!review) throw new AppError('REVIEW_NOT_FOUND', 'Review not found.', 404);
      if (Number(review.status_version) !== expectedVersion) {
        throw new AppError('REVIEW_MODERATION_CONFLICT', 'This review was moderated by someone else. Refresh and try again.', 409);
      }
      if (review.status === spec.to) return { status: spec.to, statusVersion: Number(review.status_version) };
      if (!spec.from.includes(review.status)) {
        throw new AppError('INVALID_REVIEW_TRANSITION', `A ${review.status} review cannot be ${action}ed.`, 409);
      }

      const won = await this.repository.transitionStatus(tx, review.id, {
        fromVersion: expectedVersion, toStatus: spec.to, reason, staffId,
        publishedAt: spec.to === 'PUBLISHED' && !review.published_at ? new Date() : null,
      });
      if (!won) throw new AppError('REVIEW_MODERATION_CONFLICT', 'This review was moderated by someone else.', 409);

      await this.repository.recordEvent(tx, review.id, {
        eventType: `REVIEW_${spec.to}`, fromStatus: review.status, toStatus: spec.to,
        actorType: 'STAFF', actorId: staffId, reason,
      });

      // A transition into or out of PUBLISHED changes the aggregate.
      if (review.status === 'PUBLISHED' || spec.to === 'PUBLISHED') {
        await this.repository.recomputeAggregate(tx, review.product_id);
      }
      return { status: spec.to, statusVersion: Number(review.status_version) + 1 };
    });
  }

  /** Full reconciliation rebuild of every product's aggregate (§76). */
  async rebuildAggregates() {
    const productIds = await this.repository.allProductIdsWithReviews();
    for (const productId of productIds) {
      await this.transaction((tx) => this.repository.recomputeAggregate(tx, productId));
    }
    return { rebuilt: productIds.length };
  }
}

export const reviewAdminService = new ReviewAdminService();
