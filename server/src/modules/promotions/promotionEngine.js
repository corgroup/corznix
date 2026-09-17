// Wave 8G-6 — pure promotion evaluation + discount allocation.
//
// No I/O here. Everything is integer minor units; percentages are basis points
// (10000 bps = 100%). The engine is deterministic: promotions sort by
// `priority` ASC then `id` ASC (stable tie-breaker), and an exclusive
// promotion consumes the whole slot (§111/§112).

/** @typedef {{ id, version, name, discountType, discountScope, discountValue, maxDiscountMinor, minSubtotalMinor, minQuantity, eligibleProductIds, eligibleCategoryIds, eligibleCollectionIds, eligibleSegmentId, firstOrderOnly, stackable, priority }} Promotion */
/** @typedef {{ lineKey, productId, categoryIds, collectionIds, unitPriceMinor, quantity }} CartLine */

const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : typeof v === 'string' ? JSON.parse(v) : []);

/** A line is "eligible" for an ITEM-scope promo if it matches any configured target set. */
function lineMatchesPromotion(line, promo) {
  const products = asArray(promo.eligibleProductIds);
  const categories = asArray(promo.eligibleCategoryIds);
  const collections = asArray(promo.eligibleCollectionIds);
  if (!products.length && !categories.length && !collections.length) return true; // whole catalogue
  if (products.includes(line.productId)) return true;
  if (categories.some((c) => (line.categoryIds || []).includes(c))) return true;
  if (collections.some((c) => (line.collectionIds || []).includes(c))) return true;
  return false;
}

/**
 * @param {Promotion} promo
 * @param {{ subtotalMinor, lines: CartLine[], inSegment: boolean, isFirstOrder: boolean }} ctx
 * @returns {{ eligible: boolean, reason?: string }}
 */
export function checkEligibility(promo, ctx) {
  if (ctx.subtotalMinor < (promo.minSubtotalMinor || 0)) return { eligible: false, reason: 'MIN_SUBTOTAL_NOT_MET' };
  const totalQty = ctx.lines.reduce((s, l) => s + l.quantity, 0);
  if (totalQty < (promo.minQuantity || 0)) return { eligible: false, reason: 'MIN_QUANTITY_NOT_MET' };
  if (promo.eligibleSegmentId && !ctx.inSegment) return { eligible: false, reason: 'CUSTOMER_NOT_IN_SEGMENT' };
  if (promo.firstOrderOnly && !ctx.isFirstOrder) return { eligible: false, reason: 'NOT_FIRST_ORDER' };
  const targetedLines = ctx.lines.filter((l) => lineMatchesPromotion(l, promo));
  if (!targetedLines.length) return { eligible: false, reason: 'NO_ELIGIBLE_ITEMS' };
  return { eligible: true };
}

/** Gross value (minor) of the lines a promotion can discount. */
function targetedValue(promo, lines) {
  return lines.filter((l) => lineMatchesPromotion(l, promo))
    .reduce((s, l) => s + l.unitPriceMinor * l.quantity, 0);
}

/** Raw discount for one promotion against a base value, capped and floored. */
export function rawDiscount(promo, baseMinor) {
  let d = promo.discountType === 'PERCENTAGE'
    ? Math.floor((baseMinor * promo.discountValue) / 10000)
    : Math.min(promo.discountValue, baseMinor);
  if (promo.maxDiscountMinor != null) d = Math.min(d, promo.maxDiscountMinor);
  return Math.max(0, Math.min(d, baseMinor));
}

/**
 * Deterministically spread `totalDiscountMinor` across `lines` in proportion to
 * each line's gross value. Integer arithmetic; the rounding remainder goes to
 * the largest-value lines first, then by lineKey (§114).
 */
export function allocateToLines(totalDiscountMinor, lines) {
  const weights = lines.map((l) => ({ lineKey: l.lineKey, gross: l.unitPriceMinor * l.quantity }));
  const totalGross = weights.reduce((s, w) => s + w.gross, 0);
  if (totalGross <= 0 || totalDiscountMinor <= 0) return weights.map((w) => ({ lineKey: w.lineKey, discountMinor: 0 }));
  const base = weights.map((w) => {
    const exact = (totalDiscountMinor * w.gross) / totalGross;
    const floor = Math.floor(exact);
    return { lineKey: w.lineKey, gross: w.gross, floor, frac: exact - floor };
  });
  let remainder = totalDiscountMinor - base.reduce((s, b) => s + b.floor, 0);
  const order = [...base].sort((a, b) => b.frac - a.frac || b.gross - a.gross || (a.lineKey < b.lineKey ? -1 : 1));
  const bump = new Set();
  for (const row of order) {
    if (remainder <= 0) break;
    bump.add(row.lineKey);
    remainder -= 1;
  }
  return base.map((b) => ({ lineKey: b.lineKey, discountMinor: b.floor + (bump.has(b.lineKey) ? 1 : 0) }));
}

/**
 * Evaluate a set of candidate promotions against a cart.
 * @param {Promotion[]} candidates - already limited to promos the code/automatic rules allow
 * @param {{ subtotalMinor, lines: CartLine[], segmentIds: Set<string>, isFirstOrder: boolean }} ctx
 * @returns {{ appliedPromotions, totalDiscountMinor, lineAllocations, rejected }}
 */
export function evaluate(candidates, ctx) {
  const sorted = [...candidates].sort((a, b) => (a.priority - b.priority) || (a.id < b.id ? -1 : 1));
  const applied = [];
  const rejected = [];
  let running = ctx.subtotalMinor;
  let exclusiveTaken = false;

  for (const promo of sorted) {
    const elig = checkEligibility(promo, { ...ctx, inSegment: !promo.eligibleSegmentId || ctx.segmentIds.has(promo.eligibleSegmentId) });
    if (!elig.eligible) { rejected.push({ promotionId: promo.id, reason: elig.reason }); continue; }
    if (exclusiveTaken) { rejected.push({ promotionId: promo.id, reason: 'BLOCKED_BY_EXCLUSIVE' }); continue; }
    if (applied.length && !promo.stackable) { rejected.push({ promotionId: promo.id, reason: 'NOT_STACKABLE' }); continue; }

    const base = promo.discountScope === 'ITEM'
      ? Math.min(targetedValue(promo, ctx.lines), running)
      : running;
    const d = rawDiscount(promo, base);
    if (d <= 0) { rejected.push({ promotionId: promo.id, reason: 'ZERO_DISCOUNT' }); continue; }

    applied.push({ promotionId: promo.id, promotionVersion: promo.version, name: promo.name, discountMinor: d });
    running = Math.max(0, running - d);
    if (!promo.stackable) exclusiveTaken = true;
  }

  const totalDiscountMinor = applied.reduce((s, a) => s + a.discountMinor, 0);
  const lineAllocations = allocateToLines(totalDiscountMinor, ctx.lines);
  return { appliedPromotions: applied, totalDiscountMinor, lineAllocations, rejected };
}
