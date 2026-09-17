// Phase 2 · Slice 7 — quote snapshot + place-order revalidation.
// Pure comparison logic + the checkout stale-quote blocker. 0 provider calls.
import assert from 'node:assert/strict';
import { compareQuoteToFresh } from '../src/modules/shipping/service.js';

const results = {};
const acheck = async (name, fn) => {
  try { const v = await fn(); results[name] = v === undefined ? 'PASS' : v; }
  catch (e) { results[name] = `FAIL ${e.message}`; }
  console.log(`  ${String(results[name]).startsWith('FAIL') ? 'FAIL' : 'PASS'}  ${name}`);
};

const freshWith = (level, chargeMinor, providerServiceCode = 'DL_SVC') => ({
  serviceable: true,
  methods: [{ code: level, options: [{ serviceLevel: level, providerServiceCode, chargeMinor, rateMinor: chargeMinor }] }],
});

await acheck('unchanged_surface_quote_ok', () => {
  const snap = { serviceLevel: 'STANDARD', customerShippingChargeMinor: 0, providerServiceCode: 'DL_SVC' };
  assert.deepEqual(compareQuoteToFresh(snap, freshWith('STANDARD', 0), { toleranceMinor: 100 }), { ok: true });
});

await acheck('express_rate_within_tolerance_ok', () => {
  const snap = { serviceLevel: 'EXPRESS', customerShippingChargeMinor: 19710, providerServiceCode: 'DL_SVC' };
  assert.deepEqual(compareQuoteToFresh(snap, freshWith('EXPRESS', 19760), { toleranceMinor: 100 }), { ok: true });
});

await acheck('express_rate_moved_beyond_tolerance_blocks', () => {
  const snap = { serviceLevel: 'EXPRESS', customerShippingChargeMinor: 19710, providerServiceCode: 'DL_SVC' };
  const r = compareQuoteToFresh(snap, freshWith('EXPRESS', 24500), { toleranceMinor: 100 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'RATE_CHANGED');
  assert.equal(r.freshChargeMinor, 24500);
  assert.equal(r.priorChargeMinor, 19710);
});

await acheck('pin_now_unserviceable_blocks', () => {
  const r = compareQuoteToFresh({ serviceLevel: 'STANDARD' }, { serviceable: false, methods: [] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'PIN_UNSERVICEABLE');
});

await acheck('method_no_longer_offered_blocks', () => {
  const snap = { serviceLevel: 'EXPRESS', providerServiceCode: 'DL_SVC' };
  const r = compareQuoteToFresh(snap, freshWith('STANDARD', 0));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'METHOD_UNAVAILABLE');
});

await acheck('provider_service_code_mismatch_blocks', () => {
  const snap = { serviceLevel: 'EXPRESS', providerServiceCode: 'DL_OLD' };
  const r = compareQuoteToFresh(snap, freshWith('EXPRESS', 100, 'DL_NEW'));
  assert.equal(r.reason, 'METHOD_UNAVAILABLE');
});

// ---- checkout stale-quote blocker (MOCK, DB-backed) -----------
await acheck('checkout_map_flags_expired_quote', async () => {
  const { CheckoutService } = await import('../src/modules/checkout/service.js').then((m) => ({ CheckoutService: m.checkoutService.constructor }));
  const svc = new CheckoutService();
  const past = new Date(Date.now() - 60_000).toISOString();
  const row = {
    id: 'c1', status: 'READY_FOR_PAYMENT', currency: 'INR', reservation_status: 'RESERVED',
    subtotal_minor: 100000, shipping_minor: 0, total_minor: 100000,
    shipping_address_snapshot: JSON.stringify({ postalCode: '110001' }),
    serviceability_snapshot: JSON.stringify({ serviceable: true, status: 'SERVICEABLE', providerChoiceMode: 'BACKEND_SELECTED', methods: [] }),
    shipping_methods_snapshot: '[]',
    shipping_quote_reference: 'q1',
    shipping_quote_expires_at: past,
    shipping_quote_snapshot: JSON.stringify({ serviceLevel: 'STANDARD', name: 'Standard', quoteExpiresAt: past }),
    items_snapshot: '[]',
  };
  const dto = svc.map(row, { items: [] });
  assert.ok(dto.readiness.blockers.includes('SHIPPING_QUOTE_EXPIRED'));
  assert.equal(dto.readiness.canProceedToPayment, false);
});

// ---- delivery re-quote (a customer past the 15-minute quote TTL) ----------
// Before this, nothing re-quoted: every shipping choice and payment was
// refused with "The shipping quote has expired" and the customer was stuck.
const { planShippingRefresh } = await import('../src/modules/checkout/service.js');
const freshQuote = (level, rateMinor, quoteId = 'fresh-q') => {
  const fresh = freshWith(level, rateMinor);
  fresh.methods[0].options[0].quoteId = quoteId;
  return fresh;
};

await acheck('refresh_keeps_same_method_at_same_charge', () => {
  const plan = planShippingRefresh({ serviceLevel: 'STANDARD', providerServiceCode: 'DL_SVC', rateMinor: 4900, quoteId: 'old-q' }, freshQuote('STANDARD', 4900));
  assert.equal(plan.action, 'KEEP');
  assert.equal(plan.option.quoteId, 'fresh-q');
});

await acheck('refresh_drops_selection_when_charge_moves_at_all', () => {
  const plan = planShippingRefresh({ serviceLevel: 'STANDARD', providerServiceCode: 'DL_SVC', rateMinor: 4900 }, freshQuote('STANDARD', 4950));
  assert.deepEqual(plan, { action: 'RESET', reason: 'RATE_CHANGED' });
});

await acheck('refresh_compares_the_charged_field', () => {
  // A snapshot whose customerShippingChargeMinor matches but rateMinor (what the checkout charges) does not.
  const plan = planShippingRefresh({ serviceLevel: 'STANDARD', providerServiceCode: 'DL_SVC', customerShippingChargeMinor: 0, rateMinor: 4900 }, freshQuote('STANDARD', 0));
  assert.deepEqual(plan, { action: 'RESET', reason: 'RATE_CHANGED' });
});

await acheck('refresh_drops_selection_when_method_gone', () => {
  const plan = planShippingRefresh({ serviceLevel: 'EXPRESS', providerServiceCode: 'DL_SVC', rateMinor: 0 }, freshQuote('STANDARD', 0));
  assert.deepEqual(plan, { action: 'RESET', reason: 'METHOD_UNAVAILABLE' });
});

await acheck('refresh_drops_selection_when_pin_unserviceable', () => {
  const plan = planShippingRefresh({ serviceLevel: 'STANDARD', rateMinor: 0 }, { serviceable: false, methods: [] });
  assert.deepEqual(plan, { action: 'RESET', reason: 'PIN_UNSERVICEABLE' });
});

await acheck('refresh_without_selection_only_updates_options', () => {
  assert.deepEqual(planShippingRefresh(null, freshQuote('STANDARD', 0)), { action: 'SNAPSHOT_ONLY' });
});

await acheck('refresh_route_is_registered', async () => {
  const router = (await import('../src/modules/checkout/routes.js')).default;
  assert.ok(router.stack.some((layer) => layer.route?.path === '/:id/shipping-quote/refresh' && layer.route.methods.post));
});

console.log('\n──── Phase 2 · Slice 7 — quote revalidation ────');
const failed = Object.entries(results).filter(([, v]) => String(v).startsWith('FAIL'));
console.log(`\nQUOTE_REVALIDATION = ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length})`}`);
console.log('REAL_PROVIDER_CALLS = 0');
process.exitCode = failed.length === 0 ? 0 : 1;
