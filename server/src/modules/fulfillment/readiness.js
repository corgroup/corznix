// Booking readiness is deliberately separate from operational fulfillment
// status (§20). A fulfillment can sit at status PENDING while readiness is
// BLOCKED with a concrete reason, or READY once every gate clears.

export const READINESS = Object.freeze({ READY: 'READY', BLOCKED: 'BLOCKED' });

export const BLOCK_REASON = Object.freeze({
  MISSING_SHIPPING_ADDRESS: 'MISSING_SHIPPING_ADDRESS',
  MISSING_SHIPPING_METADATA: 'MISSING_SHIPPING_METADATA',
  INVALID_ORDER_STATE: 'INVALID_ORDER_STATE',
  ORDER_CANCELLED: 'ORDER_CANCELLED',
  NO_FULFILLABLE_ITEMS: 'NO_FULFILLABLE_ITEMS',
});

const REQUIRED_ADDRESS_FIELDS = ['firstName', 'addressLine1', 'city', 'state', 'postalCode', 'phone', 'country'];
const PIN_RE = /^\d{6}$/;

/**
 * @param {object} input
 * @param {string} input.orderStatus       orders.order_status
 * @param {object|null} input.shippingAddress  immutable Order address snapshot
 * @param {Array} input.allocations        [{ skuId, quantity }]
 * @param {Array} input.packageItems       resolved shipping metadata rows
 *        [{ skuId, quantity, fulfillment: {weightGrams,...}|null }]
 * @returns {{ readinessStatus: string, blockReason: string|null }}
 */
export function evaluateReadiness({ orderStatus, shippingAddress, allocations, packageItems }) {
  const blocked = (blockReason) => ({ readinessStatus: READINESS.BLOCKED, blockReason });

  if (orderStatus === 'CANCELLED') return blocked(BLOCK_REASON.ORDER_CANCELLED);
  if (orderStatus !== 'PLACED') return blocked(BLOCK_REASON.INVALID_ORDER_STATE);

  if (!allocations?.length || allocations.every((allocation) => Number(allocation.quantity) <= 0)) {
    return blocked(BLOCK_REASON.NO_FULFILLABLE_ITEMS);
  }

  const address = shippingAddress || {};
  const addressComplete = REQUIRED_ADDRESS_FIELDS.every((field) => String(address[field] ?? '').trim().length > 0)
    && PIN_RE.test(String(address.postalCode ?? ''));
  if (!addressComplete) return blocked(BLOCK_REASON.MISSING_SHIPPING_ADDRESS);

  // Carrier-required package metadata comes only from the existing product
  // shipping profile authority (§22). Absent data blocks — it is never faked (§23).
  const metadataComplete = packageItems.length > 0 && packageItems.every((item) => Boolean(item.fulfillment));
  if (!metadataComplete) return blocked(BLOCK_REASON.MISSING_SHIPPING_METADATA);

  return { readinessStatus: READINESS.READY, blockReason: null };
}

/**
 * Aggregated, provider-neutral package snapshot. Returns null when metadata is
 * incomplete so a Shipment draft can never carry fabricated weight/dimensions.
 */
export function buildPackageSnapshot(packageItems) {
  if (!packageItems.length || packageItems.some((item) => !item.fulfillment)) return null;
  const lines = packageItems.map((item) => ({
    skuId: item.skuId,
    quantity: Number(item.quantity),
    weightGrams: item.fulfillment.weightGrams,
    lengthMm: item.fulfillment.lengthMm,
    widthMm: item.fulfillment.widthMm,
    heightMm: item.fulfillment.heightMm,
  }));
  return {
    source: 'PRODUCT_SHIPPING_PROFILE',
    totalWeightGrams: lines.reduce((sum, line) => sum + line.weightGrams * line.quantity, 0),
    lines,
  };
}
