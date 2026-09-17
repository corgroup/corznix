import { returnsRepository } from './repository.js';

// The ONE backend home for the return / replacement / exchange windows
// (§15). Nothing else in the backend types "7 days" — everything reads here.
// Mirrors apps/corcotton/src/constants/returnPolicy.js on the frontend.
const DEFAULTS = Object.freeze({
  returnWindowDays: 7,
  replacementWindowDays: 7,
  exchangeWindowDays: 7,
  reservedExchangeCreditExpiryDays: 7,
  maxReasonLength: 1000,
  sameStylePriceDifferencePolicy: 'BLOCK',
  returnDestinationStrategy: 'ORIGIN_FULFILLMENT',
  refundDestination: 'ORIGINAL_PAYMENT',
  codRefundMethod: null,
});

export class ReturnPolicyService {
  constructor({ repository = returnsRepository } = {}) {
    this.repository = repository;
    this._cache = null;
  }

  async get({ connection = null, fresh = false } = {}) {
    if (this._cache && !fresh) return this._cache;
    const row = await this.repository.policy(connection);
    const policy = row
      ? {
        returnWindowDays: Number(row.return_window_days),
        replacementWindowDays: Number(row.replacement_window_days),
        exchangeWindowDays: Number(row.exchange_window_days),
        reservedExchangeCreditExpiryDays: Number(row.reserved_exchange_credit_expiry_days),
        maxReasonLength: Number(row.max_reason_length),
        sameStylePriceDifferencePolicy: row.same_style_price_difference_policy || 'BLOCK',
        returnDestinationStrategy: row.return_destination_strategy || 'ORIGIN_FULFILLMENT',
        refundDestination: row.refund_destination || 'ORIGINAL_PAYMENT',
        codRefundMethod: row.cod_refund_method || null,
        version: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      }
      : { ...DEFAULTS, version: null };
    this._cache = policy;
    return policy;
  }

  /** Window (in days) that applies to a given request action. */
  windowDaysFor(action, policy) {
    if (action === 'REPLACEMENT') return policy.replacementWindowDays;
    if (action === 'SAME_STYLE_EXCHANGE' || action === 'DIFFERENT_STYLE_EXCHANGE') return policy.exchangeWindowDays;
    return policy.returnWindowDays;
  }

  invalidate() { this._cache = null; }
}

export const returnPolicyService = new ReturnPolicyService();
export { DEFAULTS as RETURN_POLICY_DEFAULTS };
