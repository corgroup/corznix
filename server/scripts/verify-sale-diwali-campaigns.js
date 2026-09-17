// Sale + Diwali campaigns — verification.
//
// Proves, against the real DB and the real pricing/content engines (no
// mocks, no real send/charge):
//   DIWALI_PROMOTION_APPLIES_IN_WINDOW — the real promotions.quote() engine
//     computes a genuine 20% discount when `now` is inside the Diwali window.
//   DIWALI_PROMOTION_INERT_OUTSIDE_WINDOW — the same promotion contributes
//     nothing when `now` is today (outside its window), even though it is
//     ACTIVE — proving "future-dated + ACTIVE" is safe.
//   SALE_PROMOTION_DRAFT_NEVER_APPLIES — the Storewide Sale promotion is
//     DRAFT; quote() ignores it entirely regardless of `now`.
//   EXPERIENCE_BASE_TODAY — resolveExperience(today) shows no campaign (the
//     base theme, no banner) — neither seasonal campaign is live right now.
//   EXPERIENCE_DIWALI_LIVE_IN_WINDOW — resolveExperience(inside the Diwali
//     window) resolves the Diwali theme + banner + announcement.
//   EXPERIENCE_SALE_NOT_LIVE_UNPUBLISHED — resolveExperience(inside the
//     Sale campaign's own window) still shows no campaign, because the Sale
//     campaign has not been published — an unpublished campaign is never
//     visible to a real customer, only via includeDrafts (CMS preview).
//   EXPERIENCE_SALE_PREVIEWABLE — includeDrafts:true (the CMS preview path)
//     DOES resolve the Sale campaign's draft, so staff can review it before
//     publishing.
//
// Read-only against seeded data (npm run seed:sale-diwali-campaigns must have
// run first) — no writes, nothing to clean up.
//
//   npm run verify:sale-diwali-campaigns
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const { pool, query } = await import('../src/database/connection/pool.js');
const { promotionService } = await import('../src/modules/promotions/service.js');
const { resolveExperience } = await import('../src/modules/content/campaignService.js');

const results = {};
const pass = (n, d) => { results[n] = d ? `PASS (${d})` : 'PASS'; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); };

const DIWALI_INSIDE = new Date('2026-11-01T12:00:00.000Z');
const DIWALI_OUTSIDE = new Date(); // today, 2026-09-04 — well before the window
const SALE_WINDOW_NOW = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000); // 2 days from now — inside the sale's own window, not Diwali's

const SUBTOTAL = 200000; // ₹2,000.00
const LINES = [{ skuId: 'verify-fixture-sku', quantity: 1, unitPriceMinor: SUBTOTAL }];

let createdCustomerId = null;
try {
  // A customer row is only needed as a quote fixture. seed.js seeds the
  // catalog but no customers, so on a freshly-seeded database (CI) there are
  // none — create a throwaway and remove it again below rather than requiring
  // a hand-built dev DB.
  let [anyCustomer] = await query('SELECT id FROM customers LIMIT 1');
  if (!anyCustomer) {
    const tmpId = randomUUID();
    await query("INSERT INTO customers (id, brand_id, status) VALUES (?, (SELECT id FROM brands WHERE slug='corcotton'), 'ACTIVE')", [tmpId]);
    createdCustomerId = tmpId;
    anyCustomer = { id: tmpId };
  }
  assert(anyCustomer, 'need at least one seeded customer');
  const customerId = anyCustomer.id;

  // ===================== promotions engine ==========================
  {
    const q = await promotionService.quote({ customerId, subtotalMinor: SUBTOTAL, lines: LINES, now: DIWALI_INSIDE });
    const diwali = q.appliedPromotions.find((a) => /Diwali/i.test(a.name || ''));
    assert(diwali, 'the Diwali promotion must apply inside its window');
    assert.equal(q.totalDiscountMinor, Math.round(SUBTOTAL * 0.20), 'discount must be exactly 20% of the subtotal');
    pass('DIWALI_PROMOTION_APPLIES_IN_WINDOW', `₹${(q.totalDiscountMinor / 100).toFixed(2)} off a ₹${(SUBTOTAL / 100).toFixed(2)} order`);
  }
  {
    const q = await promotionService.quote({ customerId, subtotalMinor: SUBTOTAL, lines: LINES, now: DIWALI_OUTSIDE });
    const diwali = q.appliedPromotions.find((a) => /Diwali/i.test(a.name || ''));
    assert(!diwali, 'the Diwali promotion must NOT apply outside its window, even though it is ACTIVE');
    pass('DIWALI_PROMOTION_INERT_OUTSIDE_WINDOW', 'ACTIVE + future-dated = correctly inert today');
  }
  {
    const q = await promotionService.quote({ customerId, subtotalMinor: SUBTOTAL, lines: LINES, now: SALE_WINDOW_NOW });
    const sale = q.appliedPromotions.find((a) => /Storewide Sale/i.test(a.name || ''));
    assert(!sale, 'the DRAFT Storewide Sale promotion must never apply');
    pass('SALE_PROMOTION_DRAFT_NEVER_APPLIES', 'DRAFT status is excluded from promotionService quote() regardless of date');
  }

  // ===================== content/experience engine ===================
  {
    const exp = await resolveExperience({ now: DIWALI_OUTSIDE });
    assert.equal(exp.campaign, null, 'no seasonal campaign should be live today');
    assert.equal(exp.banner, null);
    pass('EXPERIENCE_BASE_TODAY', 'base theme, no banner, no announcement overlay');
  }
  {
    const exp = await resolveExperience({ now: DIWALI_INSIDE });
    assert(exp.campaign && /diwali/i.test(exp.campaign.key), 'the Diwali campaign must be the live campaign inside its window');
    assert(exp.banner && /Diwali/i.test(exp.banner.text), 'the Diwali banner must be resolved');
    assert.equal(exp.theme.tokens.accent, '#b8860b', 'the Diwali theme accent must be applied');
    pass('EXPERIENCE_DIWALI_LIVE_IN_WINDOW', `banner: "${exp.banner.text}"`);
  }
  {
    const exp = await resolveExperience({ now: SALE_WINDOW_NOW });
    assert.equal(exp.campaign, null, 'the unpublished Sale campaign must not be visible to a real customer');
    pass('EXPERIENCE_SALE_NOT_LIVE_UNPUBLISHED', 'an unpublished campaign never reaches a real customer');
  }
  {
    const exp = await resolveExperience({ now: SALE_WINDOW_NOW, includeDrafts: true });
    assert(exp.campaign && exp.campaign.key === 'seasonal_sale', 'CMS preview (includeDrafts) must resolve the draft Sale campaign');
    pass('EXPERIENCE_SALE_PREVIEWABLE', 'staff can preview the unpublished campaign before publishing it');
  }

  console.log('\nSale + Diwali campaigns — ALL CHECKS PASSED\n');
  console.log(JSON.stringify(results, null, 2));
} finally {
  if (createdCustomerId) await query('DELETE FROM customers WHERE id = ?', [createdCustomerId]).catch(() => {});
  await pool.end();
}
