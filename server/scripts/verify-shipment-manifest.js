// Phase 2 · Slice 10 — Delhivery shipment creation (manifest) + AWB.
//
// Isolated fixture test. global.fetch stubbed — NO real provider call.
//   * payload built ONLY from the provider-neutral request; every field from
//     Dev_API.docx § Create payload; missing required ⇒ fail before any call
//   * body is `format=json&data=<url-encoded JSON>` (doc form; no raw & # % ; \)
//   * response with no waybill ⇒ FAIL LOUD, never a fabricated AWB
//   * timeout / 5xx after send ⇒ AMBIGUOUS (booking may exist — reconcile, don't
//     blindly re-create); 4xx ⇒ definite rejection
//   * createShipment is now a declared capability
import assert from 'node:assert/strict';
import {
  buildManifestPayload, encodeManifestBody, parseManifestResponse,
} from '../src/modules/shipping/providers/delhiveryManifest.js';
import { DelhiveryShippingAdapter } from '../src/modules/shipping/providers/delhiveryAdapter.js';

const results = {};
const acheck = async (name, fn) => {
  try { const v = await fn(); results[name] = v === undefined ? 'PASS' : v; }
  catch (e) { results[name] = `FAIL ${e.message}`; }
  console.log(`  ${String(results[name]).startsWith('FAIL') ? 'FAIL' : 'PASS'}  ${name}`);
};
const check = (name, fn) => acheck(name, async () => fn());

const REAL_ENV = {
  SHIPPING_PROVIDER_MODE: 'REAL',
  DELHIVERY_API_BASE_URL: 'https://staging-express.delhivery.com',
  DELHIVERY_API_TOKEN: 'test-token',
  SHIPPING_PROVIDER_TIMEOUT_MS: 5000,
};
const adapter = () => new DelhiveryShippingAdapter({ runtimeEnv: REAL_ENV });

const fullRequest = () => ({
  clientReference: 'SHP-1', orderReference: 'COR-20260902-ABC', providerCode: 'DELHIVERY',
  pickupLocationName: 'CORCOTTON ND 01', serviceLevel: 'STANDARD', productsDesc: 'Apparel',
  origin: { name: 'CORCOTTON WH', address: '17 Parasupur', city: 'Ghazipur', state: 'Uttar Pradesh', postalCode: '233222', phone: '9999999999' },
  destination: { name: 'Test Buyer', phone: '9888877776', address: 'Huda Market', city: 'Gurugram', state: 'Haryana', postalCode: '122001', country: 'India' },
  package: { weightGrams: 500, lengthMm: 300, widthMm: 220, heightMm: 50 },
  payment: { mode: 'PREPAID', codCollectionMinor: 0, orderValueMinor: 149900 },
});

// A real parcel came back with the return address printed over the order
// barcode: the strip is one fixed-width line, and the warehouse address (which
// also repeated a part of itself) was far too long for it.
check('return_address_is_one_short_line_that_cannot_reach_the_barcode', () => {
  const req = fullRequest();
  req.origin.address = 'CO AASHA DEVI, Building No. 17, Parasupur, Parasupur, Parsu Pur, Ghazipur, Uttar Pradesh';
  const s = buildManifestPayload(req).dataObject.shipments[0];
  assert.ok(s.return_address.length <= 60, `return_address is ${s.return_address.length} chars`);
  assert.equal((s.return_address.match(/Parasupur/gi) || []).length, 1, 'repeated parts are dropped');
  assert.ok(!/,\s*$/.test(s.return_address), 'no trailing separator');
  // City / state / PIN ride their own fields on the same strip, so they must
  // not be duplicated into the line as well.
  assert.equal(s.return_city, 'Ghazipur');
  assert.equal(s.return_pin, '233222');
  return `PASS ("${s.return_address}")`;
});

check('seller_address_carries_the_gst_registered_address', () => {
  const req = fullRequest();
  req.sellerAddress = 'H.No 17, Parasupur, Ghazipur, Uttar Pradesh 233222 · GSTIN: 09ABCDE1234F1Z5';
  const s = buildManifestPayload(req).dataObject.shipments[0];
  assert.equal(s.seller_add, req.sellerAddress);
  // Without a company profile the warehouse address is still printed — a
  // blank seller block on a parcel is worse than an unregistered one.
  const fallback = buildManifestPayload(fullRequest()).dataObject.shipments[0];
  assert.equal(fallback.seller_add, '17 Parasupur');
});

check('build_payload_happy', () => {
  const { dataObject } = buildManifestPayload(fullRequest());
  const s = dataObject.shipments[0];
  assert.equal(s.name, 'Test Buyer');
  assert.equal(s.order, 'COR-20260902-ABC');
  assert.equal(s.pin, '122001');
  assert.equal(s.payment_mode, 'Prepaid');
  assert.equal(s.weight, '500');
  assert.equal(s.shipment_length, '30'); // 300mm -> 30cm
  assert.equal(s.shipping_mode, 'Surface');
  assert.equal(s.total_amount, '1499.00');
  assert.equal(s.waybill, ''); // SPS auto-assign
  assert.equal(dataObject.pickup_location.name, 'CORCOTTON ND 01');
});

check('build_payload_cod', () => {
  const req = fullRequest();
  req.payment = { mode: 'COD', codCollectionMinor: 149900, orderValueMinor: 149900 };
  const s = buildManifestPayload(req).dataObject.shipments[0];
  assert.equal(s.payment_mode, 'COD');
  assert.equal(s.cod_amount, '1499.00');
});

check('build_payload_missing_required_fails_before_call', () => {
  const req = fullRequest();
  delete req.destination.address;
  req.pickupLocationName = null;
  try {
    buildManifestPayload(req);
    throw new Error('should have thrown');
  } catch (e) {
    assert.equal(e.code, 'MANIFEST_PAYLOAD_INCOMPLETE');
    assert.ok(e.missing.includes('destination.address'));
    assert.ok(e.missing.includes('pickupLocationName'));
  }
});

check('encode_body_form_and_urlencoded', () => {
  const { dataObject } = buildManifestPayload(fullRequest());
  const { body } = encodeManifestBody(dataObject);
  assert.ok(body.startsWith('format=json&data='));
  const encoded = body.slice('format=json&data='.length);
  // the JSON payload must be url-encoded — a literal { must not appear
  assert.ok(!encoded.includes('{'));
  assert.deepEqual(JSON.parse(decodeURIComponent(encoded)), dataObject);
});

check('parse_response_success', () => {
  const r = parseManifestResponse({ success: true, packages: [{ waybill: '3451910000123', status: 'Success' }] });
  assert.equal(r.ok, true);
  assert.equal(r.awb, '3451910000123');
});

check('parse_response_rejection', () => {
  const r = parseManifestResponse({ success: false, rmk: 'pincode not serviceable' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PROVIDER_REJECTED');
  assert.equal(r.remark, 'pincode not serviceable');
});

check('parse_response_no_awb_never_fabricates', () => {
  const r = parseManifestResponse({ some: 'thing' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PROVIDER_RESPONSE_INVALID');
});

// ---- adapter.createShipment (stubbed fetch) ------------------------
let lastCall = null;
const stubFetch = (impl) => {
  global.fetch = async (url, options) => { lastCall = { url: String(url), options }; return impl(); };
};
const jsonResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

await acheck('createShipment_success', async () => {
  stubFetch(() => jsonResponse({ success: true, packages: [{ waybill: '3451910000123' }] }));
  const r = await adapter().createShipment(fullRequest());
  assert.equal(r.providerCode, 'DELHIVERY');
  assert.equal(r.awbNumber, '3451910000123');
  assert.equal(r.providerShipmentId, '3451910000123');
  assert.equal(r.status, 'BOOKED');
  assert.ok(r.trackingUrl.includes('3451910000123'));
  assert.equal(lastCall.url, 'https://staging-express.delhivery.com/api/cmu/create.json');
  assert.equal(lastCall.options.method, 'POST');
  assert.ok(lastCall.options.body.startsWith('format=json&data='));
  assert.equal(lastCall.options.headers.Authorization, 'Token test-token');
});

await acheck('createShipment_timeout_is_ambiguous', async () => {
  global.fetch = async (url, options) => {
    await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  };
  await adapter().createShipment(fullRequest()).then(
    () => { throw new Error('should have thrown'); },
    (e) => { assert.equal(e.message, 'SHIPPING_PROVIDER_TIMEOUT'); assert.equal(e.ambiguous, true); },
  );
});

await acheck('createShipment_5xx_is_ambiguous', async () => {
  stubFetch(() => jsonResponse({ error: 'gateway' }, 502));
  await adapter().createShipment(fullRequest()).then(
    () => { throw new Error('should have thrown'); },
    (e) => { assert.equal(e.message, 'SHIPPING_PROVIDER_UNAVAILABLE'); assert.equal(e.ambiguous, true); },
  );
});

await acheck('createShipment_4xx_is_definite_failure', async () => {
  stubFetch(() => jsonResponse({ success: false, rmk: 'bad request' }, 400));
  await adapter().createShipment(fullRequest()).then(
    () => { throw new Error('should have thrown'); },
    (e) => { assert.equal(e.message, 'SHIPPING_PROVIDER_REJECTED'); assert.ok(!e.ambiguous); },
  );
});

await acheck('createShipment_rejection_body_not_leaked', async () => {
  stubFetch(() => jsonResponse({ success: false, rmk: 'SAFE REASON', debug_stack: 'INTERNAL PROVIDER STACK' }));
  await adapter().createShipment(fullRequest()).then(
    () => { throw new Error('should have thrown'); },
    (e) => {
      assert.equal(e.message, 'SHIPPING_PROVIDER_REJECTED');
      assert.equal(e.providerReason, 'SAFE REASON');
      assert.ok(!/INTERNAL PROVIDER STACK/.test(JSON.stringify(e)));
    },
  );
});

await acheck('capability_declared', () => {
  assert.equal(adapter().supports('createShipment'), true);
});


// ---- Selected shipping method survives the whole chain -------------------
// The one ternary in orderOps/service.js and the one in delhiveryManifest.js
// are the entire path from "what the customer picked" to "what the courier is
// told". The happy-path test above only ever asserted Surface, so either could
// have been inverted or dropped and it would still have passed.
//
// `serviceLevelForBooking` mirrors orderOps/service.js:253 — the step that
// reads orders.shipping_snapshot and builds the booking request.
const serviceLevelForBooking = (shippingSnap) => (shippingSnap.serviceLevel === 'EXPRESS' ? 'EXPRESS' : 'STANDARD');

await acheck('express_selection_reaches_manifest_as_express', () => {
  // orders.shipping_snapshot as orders/repository.js writes it at placement.
  const orderSnapshot = { serviceLevel: 'EXPRESS', providerCode: 'DELHIVERY', providerServiceCode: 'PIN_SERVICEABILITY' };
  const booking = { ...fullRequest(), serviceLevel: serviceLevelForBooking(orderSnapshot) };
  assert.equal(booking.serviceLevel, 'EXPRESS', 'booking request carries the order\'s service level');
  const { dataObject } = buildManifestPayload(booking);
  assert.equal(dataObject.shipments[0].shipping_mode, 'Express');
});

await acheck('standard_selection_reaches_manifest_as_surface', () => {
  const orderSnapshot = { serviceLevel: 'STANDARD', providerCode: 'DELHIVERY' };
  const booking = { ...fullRequest(), serviceLevel: serviceLevelForBooking(orderSnapshot) };
  assert.equal(booking.serviceLevel, 'STANDARD');
  assert.equal(buildManifestPayload(booking).dataObject.shipments[0].shipping_mode, 'Surface');
});

await acheck('unknown_service_level_falls_back_to_surface_not_express', () => {
  // A missing or unrecognised level must never silently upgrade the customer
  // to Express — that is a real cost the business did not agree to.
  for (const snap of [{}, { serviceLevel: null }, { serviceLevel: 'OWNER_DELIVERY' }]) {
    const booking = { ...fullRequest(), serviceLevel: serviceLevelForBooking(snap) };
    assert.equal(buildManifestPayload(booking).dataObject.shipments[0].shipping_mode, 'Surface');
  }
});
console.log('\n──── Phase 2 · Slice 10 — Delhivery manifest / AWB ────');
const failed = Object.entries(results).filter(([, v]) => String(v).startsWith('FAIL'));
console.log(`\nDELHIVERY_MANIFEST = ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length})`}`);
console.log('REAL_PROVIDER_CALLS = 0 (fixture-only)');
process.exitCode = failed.length === 0 ? 0 : 1;
