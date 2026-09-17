// Phase 2 · Slice 18 — NDR (Non-Delivery Report) actions.
//
// Isolated fixture test. global.fetch stubbed for the adapter; NdrService runs
// with injected repository / orchestrator / db stubs — NO real DB, NO real
// provider call.
//
//   * request `act` values + endpoints are from Dev_API.docx; the response
//     bodies are not field-specced -> parsers fail loud, never fabricate a
//     UPL id or a resolution
//   * RE_ATTEMPT is capped per shipment ("attempt 1-2")
//   * submit is ASYNC (returns a UPL id) -> poll get_bulk_upl
//   * an ambiguous submit is UNKNOWN, never assumed applied
import assert from 'node:assert/strict';
import { DelhiveryShippingAdapter } from '../src/modules/shipping/providers/delhiveryAdapter.js';
import { MockShippingAdapter } from '../src/modules/shipping/providers/mockAdapter.js';
import { buildNdrUpdateBody, parseNdrUpdateResponse, parseNdrStatusResponse } from '../src/modules/shipping/providers/delhiveryNdr.js';
import { NdrService } from '../src/modules/logistics/ndrService.js';
import { NOTIFICATION_POLICIES } from '../src/modules/notifications/policies.js';

const results = {};
const acheck = async (name, fn) => {
  try { const v = await fn(); results[name] = v === undefined ? 'PASS' : v; }
  catch (e) { results[name] = `FAIL ${e.message}`; }
  console.log(`  ${String(results[name]).startsWith('FAIL') ? 'FAIL' : 'PASS'}  ${name}`);
};

const REAL_ENV = {
  SHIPPING_PROVIDER_MODE: 'REAL',
  DELHIVERY_API_BASE_URL: 'https://staging-express.delhivery.com',
  DELHIVERY_API_TOKEN: 'test-token',
  SHIPPING_PROVIDER_TIMEOUT_MS: 5000,
};
const dAdapter = () => new DelhiveryShippingAdapter({ runtimeEnv: REAL_ENV });
let lastCall = null;
const stubFetch = (impl) => { global.fetch = async (url, options) => { lastCall = { url: new URL(url), options }; return impl(); }; };
const jsonResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// ---- pure -------------------------------------------------------
await acheck('build_update_body_maps_act', () => {
  assert.deepEqual(buildNdrUpdateBody({ awb: '345', action: 'RE_ATTEMPT' }), { data: [{ waybill: '345', act: 'RE-ATTEMPT' }] });
  assert.deepEqual(buildNdrUpdateBody({ awb: '345', action: 'RESCHEDULE' }), { data: [{ waybill: '345', act: 'PICKUP_RESCHEDULE' }] });
  assert.throws(() => buildNdrUpdateBody({ awb: '', action: 'RE_ATTEMPT' }));
  assert.throws(() => buildNdrUpdateBody({ awb: '1', action: 'NOPE' }));
});

await acheck('parse_update_response_finds_upl', () => {
  assert.deepEqual(parseNdrUpdateResponse({ upl: 'UPL-1' }), { ok: true, uplId: 'UPL-1' });
  assert.deepEqual(parseNdrUpdateResponse({ request_id: 'r-9' }), { ok: true, uplId: 'r-9' });
  assert.equal(parseNdrUpdateResponse({ success: false, error: 'bad waybill' }).ok, false);
  assert.equal(parseNdrUpdateResponse({}).ok, false);
});

await acheck('parse_status_response_classifies', () => {
  assert.equal(parseNdrStatusResponse({ status: 'Success' }).state, 'ACCEPTED');
  assert.equal(parseNdrStatusResponse({ status: 'Rejected - address incomplete' }).state, 'REJECTED');
  assert.equal(parseNdrStatusResponse({ status: 'In progress' }).state, 'PENDING');
  assert.equal(parseNdrStatusResponse({ foo: 'bar' }).state, 'UNKNOWN');
  assert.equal(parseNdrStatusResponse(null).state, 'UNKNOWN');
});

// ---- adapter --------------------------------------------------
await acheck('ndr_capabilities', () => {
  assert.equal(dAdapter().supports('submitNdrAction'), true);
  assert.equal(dAdapter().supports('getNdrStatus'), true);
});

await acheck('submit_ndr_posts_update', async () => {
  stubFetch(() => jsonResponse({ upl: 'UPL-777' }));
  const r = await dAdapter().submitNdrAction({ awb: '3451910000123', action: 'RE_ATTEMPT' });
  assert.equal(lastCall.url.pathname, '/api/p/update');
  assert.equal(lastCall.options.method, 'POST');
  assert.deepEqual(JSON.parse(lastCall.options.body), { data: [{ waybill: '3451910000123', act: 'RE-ATTEMPT' }] });
  assert.equal(r.uplId, 'UPL-777');
  assert.equal(r.status, 'SUBMITTED');
});

await acheck('submit_ndr_rejection_throws', async () => {
  stubFetch(() => jsonResponse({ success: false, error: 'waybill not eligible' }));
  await assert.rejects(() => dAdapter().submitNdrAction({ awb: '1', action: 'RE_ATTEMPT' }), (e) => e.message === 'SHIPPING_PROVIDER_REJECTED');
});

await acheck('submit_ndr_auth_failure_mapped', async () => {
  stubFetch(() => jsonResponse({ message: 'Invalid token' }, 401));
  await assert.rejects(() => dAdapter().submitNdrAction({ awb: '1', action: 'RE_ATTEMPT' }), (e) => e.message === 'SHIPPING_PROVIDER_AUTH_FAILED');
});

await acheck('submit_ndr_timeout_is_ambiguous', async () => {
  global.fetch = async (url, options) => {
    await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  };
  await dAdapter().submitNdrAction({ awb: '1', action: 'RE_ATTEMPT' }).then(
    () => { throw new Error('should have thrown'); },
    (e) => { assert.equal(e.ambiguous, true); },
  );
});

await acheck('get_ndr_status_query', async () => {
  stubFetch(() => jsonResponse({ 'UPL-777': { status: 'success' } }));
  const r = await dAdapter().getNdrStatus({ uplId: 'UPL-777', awb: '345' });
  assert.equal(lastCall.url.pathname, '/api/cmu/get_bulk_upl/UPL-777');
  assert.equal(lastCall.url.searchParams.get('verbose'), 'true');
  assert.equal(r.state, 'ACCEPTED');
});

// ---- service (no DB) -----------------------------------------
const makeService = ({ shipment, events = [], actions = [], orchestrator, capture = {} }) => {
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const db = async (sql, params) => {
    const q = norm(sql);
    capture.sql = [...(capture.sql || []), { q, params }];
    if (/^SELECT \* FROM shipment_ndr_actions WHERE shipment_id = \?/.test(q)) return actions;
    if (/^SELECT nsl_code.*FROM shipment_events WHERE shipment_id = \? AND normalized_status = 'DELIVERY_EXCEPTION'/.test(q)) return events;
    if (/^SELECT \* FROM shipment_ndr_actions WHERE idempotency_key = \?/.test(q)) {
      return actions.filter((a) => a.idempotency_key === params[0]);
    }
    if (/^SELECT \* FROM shipment_ndr_actions WHERE id = \?/.test(q)) {
      return actions.filter((a) => a.id === params[0]);
    }
    if (/^INSERT INTO shipment_ndr_actions/.test(q)) { capture.inserted = params; return []; }
    if (/^UPDATE shipment_ndr_actions/.test(q)) { capture.updated = [...(capture.updated || []), { q, params }]; return []; }
    return [];
  };
  return new NdrService({
    repository: { async shipment() { return shipment; } },
    orchestrator: orchestrator || { async submitNdrAction() { throw new Error('not stubbed'); }, async getNdrStatus() { throw new Error('not stubbed'); } },
    db,
    maxReattempts: 2,
    now: () => new Date('2026-09-14T00:00:00Z'),
  });
};
const EXC_SHIPMENT = { id: 'shp-1', status: 'DELIVERY_EXCEPTION', tracking_number: 'AWB1', provider_code: 'DELHIVERY' };
const exc = (nsl, at) => ({ nsl_code: nsl, status_type: 'UD', provider_status: 'Undelivered', remarks: 'Consignee not available', occurred_at: at });

await acheck('nsl_hint', () => {
  const svc = makeService({ shipment: EXC_SHIPMENT });
  assert.equal(svc.nslHint('EOD-74'), 'RE_ATTEMPT');
  assert.equal(svc.nslHint('EOD-777'), 'RESCHEDULE');
  assert.equal(svc.nslHint('EOD-999'), null);
});

await acheck('context_in_exception_allows_reattempt', async () => {
  const ctx = await makeService({ shipment: EXC_SHIPMENT, events: [exc('EOD-74', '2026-09-13T18:00:00Z')] }).contextForShipment('shp-1');
  assert.equal(ctx.inException, true);
  assert.equal(ctx.attemptCount, 1);
  assert.equal(ctx.latestNslCode, 'EOD-74');
  assert.equal(ctx.nslHint, 'RE_ATTEMPT');
  assert.equal(ctx.canReAttempt, true);
});

await acheck('submit_reattempt_happy_path', async () => {
  const capture = {};
  const svc = makeService({
    shipment: EXC_SHIPMENT, events: [exc('EOD-74', '2026-09-13T18:00:00Z')], capture,
    orchestrator: { async submitNdrAction() { return { uplId: 'UPL-1', action: 'RE_ATTEMPT' }; } },
  });
  const r = await svc.submitAction({ shipmentId: 'shp-1', action: 'RE_ATTEMPT', staffUserId: 'stf-1' });
  assert.equal(r.status, 'SUBMITTED');
  assert.ok(capture.inserted, 'a PENDING row was inserted');
  assert.ok(capture.updated.some((u) => /status = 'SUBMITTED'/.test(u.q)));
});

await acheck('submit_rejects_when_not_in_exception', async () => {
  const svc = makeService({ shipment: { ...EXC_SHIPMENT, status: 'IN_TRANSIT' }, events: [] });
  await assert.rejects(() => svc.submitAction({ shipmentId: 'shp-1', action: 'RE_ATTEMPT' }), (e) => e.code === 'NDR_NOT_IN_EXCEPTION');
});

await acheck('submit_rejects_when_reattempts_exhausted', async () => {
  const prior = [
    { id: 'a1', action: 'RE_ATTEMPT', status: 'ACCEPTED', created_at: '2026-09-12T00:00:00Z' },
    { id: 'a2', action: 'RE_ATTEMPT', status: 'ACCEPTED', created_at: '2026-09-13T00:00:00Z' },
  ];
  const svc = makeService({ shipment: EXC_SHIPMENT, events: [exc('EOD-74', '2026-09-13T18:00:00Z')], actions: prior });
  await assert.rejects(() => svc.submitAction({ shipmentId: 'shp-1', action: 'RE_ATTEMPT' }), (e) => e.code === 'NDR_REATTEMPTS_EXHAUSTED');
});

await acheck('submit_rejects_when_action_pending', async () => {
  const pending = [{ id: 'a1', action: 'RE_ATTEMPT', status: 'SUBMITTED', created_at: '2026-09-13T00:00:00Z' }];
  const svc = makeService({ shipment: EXC_SHIPMENT, events: [exc('EOD-74', '2026-09-13T18:00:00Z')], actions: pending });
  await assert.rejects(() => svc.submitAction({ shipmentId: 'shp-1', action: 'RESCHEDULE' }), (e) => e.code === 'NDR_ACTION_IN_PROGRESS');
});

await acheck('submit_ambiguous_marks_unknown', async () => {
  const capture = {};
  const svc = makeService({
    shipment: EXC_SHIPMENT, events: [exc('EOD-74', '2026-09-13T18:00:00Z')], capture,
    orchestrator: { async submitNdrAction() { throw Object.assign(new Error('SHIPPING_PROVIDER_TIMEOUT'), { ambiguous: true }); } },
  });
  const r = await svc.submitAction({ shipmentId: 'shp-1', action: 'RE_ATTEMPT' });
  assert.equal(r.status, 'UNKNOWN');
  assert.equal(r.reconcile, true);
  assert.ok(capture.updated.some((u) => /status = \?/.test(u.q) && u.params[0] === 'UNKNOWN'));
});

await acheck('refresh_action_resolves_accepted', async () => {
  const capture = {};
  const row = [{ id: 'a1', action: 'RE_ATTEMPT', status: 'SUBMITTED', provider_upl_id: 'UPL-1', awb: 'AWB1', provider_code: 'DELHIVERY' }];
  const svc = makeService({
    shipment: EXC_SHIPMENT, actions: row, capture,
    orchestrator: { async getNdrStatus() { return { state: 'ACCEPTED', providerRemark: 'done' }; } },
  });
  const r = await svc.refreshAction('a1');
  assert.equal(r.status, 'ACCEPTED');
  assert.ok(capture.updated.some((u) => /resolved_at = NOW\(3\)/.test(u.q)));
});

// ---- policy + mock parity -----------------------------------
await acheck('delivery_attempt_failed_policy_registered', () => {
  const p = NOTIFICATION_POLICIES.ORDER_DELIVERY_ATTEMPT_FAILED;
  assert.ok(p);
  assert.equal(p.templateKey, 'order.delivery_attempt_failed');
  assert.deepEqual(p.channels, ['EMAIL', 'WHATSAPP']);
});

await acheck('mock_adapter_ndr', async () => {
  const m = new MockShippingAdapter({ runtimeEnv: { SHIPPING_PROVIDER_MODE: 'MOCK' }, production: false });
  const s = await m.submitNdrAction({ awb: 'MOCKAWB1', action: 'RE_ATTEMPT' });
  assert.match(s.uplId, /MOCK-UPL/);
  const st = await m.getNdrStatus({ uplId: s.uplId });
  assert.equal(st.state, 'ACCEPTED');
  await assert.rejects(() => m.submitNdrAction({ awb: 'X999', action: 'RE_ATTEMPT' }), (e) => e.message === 'SHIPPING_PROVIDER_REJECTED');
});

console.log('\n──── Phase 2 · Slice 18 — NDR ────');
const failed = Object.entries(results).filter(([, v]) => String(v).startsWith('FAIL'));
console.log(`\nSHIPMENT_NDR = ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length})`}`);
console.log('REAL_PROVIDER_CALLS = 0 (fixture-only)');
process.exitCode = failed.length === 0 ? 0 : 1;
