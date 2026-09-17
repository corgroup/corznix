// Phase 2 · Slice 17 — carrier documents (EPOD / QC / Sorter push + Download
// Document API).
//
// Isolated fixture test. global.fetch stubbed for the adapter; the service runs
// with injected repository / orchestrator / storage / db stubs — NO real DB,
// NO real provider call, NO bytes written to disk.
//
//   * response shape not in Dev_API.docx ⇒ parser returns a URL only when one
//     is really present — never fabricated
//   * a base64 push image is copied into private storage; a URL push is linked
//   * AWB is the trusted link key; the provider order ref is advisory only
//   * a replayed webhook is ONE row
//   * OBSERVE mode records nothing
import assert from 'node:assert/strict';
import { DelhiveryShippingAdapter } from '../src/modules/shipping/providers/delhiveryAdapter.js';
import { MockShippingAdapter } from '../src/modules/shipping/providers/mockAdapter.js';
import { parseDocumentResponse } from '../src/modules/shipping/providers/delhiveryDocuments.js';
import { parseDelhiveryEpod, parseDelhiveryQcImage } from '../src/modules/logistics/delhiveryDocumentPush.js';
import { CarrierDocumentService } from '../src/modules/logistics/carrierDocumentService.js';

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

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
const PNG_B64 = PNG.toString('base64');

// ---- pure parser -------------------------------------------------
await acheck('doc_response_parser_finds_url', () => {
  assert.deepEqual(parseDocumentResponse({ url: 'https://s3/doc.pdf' }), { ok: true, url: 'https://s3/doc.pdf' });
  assert.deepEqual(parseDocumentResponse({ data: { s3_link: 'https://s3/x.png' } }), { ok: true, url: 'https://s3/x.png' });
  assert.equal(parseDocumentResponse({ status: 'processing' }).ok, false);
  assert.equal(parseDocumentResponse({}).ok, false);
  assert.equal(parseDocumentResponse('nope').ok, false);
});

// ---- doc-push parser -------------------------------------------
await acheck('epod_parser_surfaces_base64_attachment_not_in_summary', () => {
  const p = parseDelhiveryEpod({ waybill: '345191', EPOD: PNG_B64, orderID: 'COR-1' });
  assert.equal(p.safeSummary.imagePresent, true);
  assert.equal(p.safeSummary.imageKind, 'BASE64');
  assert.equal(p.safeSummary.imageUrl, null);
  assert.equal(p.attachment.kind, 'BASE64');
  assert.equal(p.attachment.value, PNG_B64);
  assert.ok(p.providerEventId);
});

await acheck('doc_parser_url_push_kept_in_summary', () => {
  const p = parseDelhiveryQcImage({ waybillId: '999', returnId: 'COR-9', Image: 'https://carrier/qc/999.png' });
  assert.equal(p.safeSummary.imageKind, 'URL');
  assert.equal(p.safeSummary.imageUrl, 'https://carrier/qc/999.png');
  assert.equal(p.attachment.kind, 'URL');
});

await acheck('doc_parser_event_id_tracks_image_identity', () => {
  const a = parseDelhiveryEpod({ waybill: '1', EPOD: PNG_B64 });
  const b = parseDelhiveryEpod({ waybill: '1', EPOD: PNG_B64 });
  const c = parseDelhiveryEpod({ waybill: '1', EPOD: Buffer.alloc(20, 9).toString('base64') });
  assert.equal(a.providerEventId, b.providerEventId); // identical re-push dedupes
  assert.notEqual(a.providerEventId, c.providerEventId); // different image = new event
});

// ---- adapter: Download Document -------------------------------
await acheck('get_documents_capability', () => {
  assert.equal(dAdapter().supports('getDocuments'), true);
});

await acheck('get_documents_query_and_success', async () => {
  stubFetch(() => jsonResponse({ url: 'https://s3.amazonaws.com/delhivery/epod-345.pdf' }));
  const r = await dAdapter().getDocuments({ awb: '345191', docType: 'EPOD' });
  assert.equal(lastCall.url.pathname, '/api/rest/fetch/pkg/document/');
  assert.equal(lastCall.url.searchParams.get('doc_type'), 'EPOD');
  assert.equal(lastCall.url.searchParams.get('waybill'), '345191');
  assert.equal(r.available, true);
  assert.equal(r.url, 'https://s3.amazonaws.com/delhivery/epod-345.pdf');
});

await acheck('get_documents_maps_qc_and_signature', async () => {
  stubFetch(() => jsonResponse({ url: 'https://s3/x' }));
  await dAdapter().getDocuments({ awb: '1', docType: 'QC_IMAGE' });
  assert.equal(lastCall.url.searchParams.get('doc_type'), 'RVP_QC_IMAGE');
  await dAdapter().getDocuments({ awb: '1', docType: 'SIGNATURE' });
  assert.equal(lastCall.url.searchParams.get('doc_type'), 'SIGNATURE_URL');
});

await acheck('get_documents_unknown_type_or_no_awb_rejected', async () => {
  global.fetch = async () => { throw new Error('should not run'); };
  await assert.rejects(() => dAdapter().getDocuments({ awb: '1', docType: 'SORTER_IMAGE' }), (e) => e.message === 'SHIPPING_PROVIDER_REQUEST_INVALID');
  await assert.rejects(() => dAdapter().getDocuments({ docType: 'EPOD' }), (e) => e.message === 'SHIPPING_PROVIDER_REQUEST_INVALID');
});

await acheck('get_documents_no_url_response_is_unavailable_not_error', async () => {
  stubFetch(() => jsonResponse({ status: 'not_ready' }));
  const r = await dAdapter().getDocuments({ awb: '1', docType: 'EPOD' });
  assert.equal(r.available, false);
  assert.equal(r.url, null);
});

await acheck('get_documents_auth_failure_mapped', async () => {
  stubFetch(() => jsonResponse({ message: 'Invalid token' }, 401));
  await assert.rejects(() => dAdapter().getDocuments({ awb: '1', docType: 'EPOD' }), (e) => e.message === 'SHIPPING_PROVIDER_AUTH_FAILED');
});

// ---- service (no DB, no disk) --------------------------------
const makeService = ({ shipment, rows = [], orchestrator, capture = {} }) => {
  const db = async (sql, params) => {
    capture.sql = [...(capture.sql || []), { sql: sql.replace(/\s+/g, ' ').trim(), params }];
    if (/^SELECT .* FROM shipment_provider_documents WHERE provider_code = \? AND provider_event_key/.test(sql.replace(/\s+/g, ' ').trim())) {
      return rows.filter((r) => r.provider_code === params[0] && r.provider_event_key === params[1]);
    }
    if (/^SELECT \* FROM shipment_provider_documents WHERE provider_code = \? AND doc_type/.test(sql.replace(/\s+/g, ' ').trim())) {
      return rows.filter((r) => r.doc_type === params[1]);
    }
    if (/^SELECT \* FROM shipment_provider_documents WHERE id = \?/.test(sql.replace(/\s+/g, ' ').trim())) {
      return rows.filter((r) => r.id === params[0]);
    }
    if (/^INSERT INTO shipment_provider_documents/.test(sql.replace(/\s+/g, ' ').trim())) {
      capture.inserted = { sql, params };
      return [];
    }
    if (/^UPDATE shipment_provider_documents/.test(sql.replace(/\s+/g, ' ').trim())) {
      capture.updated = [...(capture.updated || []), { sql: sql.replace(/\s+/g, ' ').trim(), params }];
      return [];
    }
    return [];
  };
  return new CarrierDocumentService({
    repository: {
      async shipment() { return shipment; },
      async shipmentByTrackingNumber(awb) {
        return shipment && shipment.tracking_number === awb
          ? { id: shipment.id, order_id: shipment.order_id, order_number: shipment.order_number }
          : null;
      },
    },
    orchestrator: orchestrator || { async getDocuments() { throw new Error('not stubbed'); } },
    storage: {
      newKey: (ext) => `2026/00000000-0000-0000-0000-000000000000.${ext}`,
      put: async (key, bytes) => { capture.put = { key, len: bytes.length }; return { key, sha256: 'deadbeef', byteSize: bytes.length }; },
      get: async () => PNG,
    },
    db,
    maxBytes: 1000,
    now: () => new Date('2026-09-12T00:00:00Z'),
  });
};
const SHIPMENT = { id: 'shp-1', order_id: 'ord-1', order_number: 'COR-20260908-ABC', tracking_number: 'AWB1', provider_code: 'DELHIVERY' };
const insertedCol = (capture, col) => {
  // Positional order of the `?` params in the WEBHOOK INSERT (source is a
  // literal 'WEBHOOK', received_at is NOW(3) — neither is a param).
  const cols = ['id', 'shipment_id', 'order_id', 'provider_code', 'awb', 'doc_type', 'provider_event_key',
    'image_status', 'image_url', 'storage_key', 'sha256', 'byte_size', 'content_type', 'provider_order_ref', 'link_status', 'metadata_json'];
  return capture.inserted.params[cols.indexOf(col)];
};

await acheck('record_base64_push_stores_bytes', async () => {
  const capture = {};
  const decision = await makeService({ shipment: SHIPMENT, capture }).recordFromWebhook({
    providerCode: 'DELHIVERY', providerEventKey: 'evt-1', docType: 'EPOD', awb: 'AWB1',
    providerOrderRef: 'COR-20260908-ABC', attachment: { kind: 'BASE64', value: PNG_B64 },
  });
  assert.equal(decision, 'APPLIED');
  assert.ok(capture.put, 'bytes written to storage');
  assert.equal(insertedCol(capture, 'image_status'), 'STORED');
  assert.equal(insertedCol(capture, 'shipment_id'), 'shp-1');
  assert.equal(insertedCol(capture, 'link_status'), 'LINKED');
});

await acheck('record_url_push_links_not_stores', async () => {
  const capture = {};
  await makeService({ shipment: SHIPMENT, capture }).recordFromWebhook({
    providerCode: 'DELHIVERY', providerEventKey: 'evt-2', docType: 'QC_IMAGE', awb: 'AWB1',
    attachment: { kind: 'URL', value: 'https://carrier/qc.png' }, imageUrl: 'https://carrier/qc.png',
  });
  assert.equal(capture.put, undefined);
  assert.equal(insertedCol(capture, 'image_status'), 'LINKED_URL');
  assert.equal(insertedCol(capture, 'image_url'), 'https://carrier/qc.png');
});

await acheck('record_oversize_or_non_image_is_pending_fetch', async () => {
  const capture = {};
  await makeService({ shipment: SHIPMENT, capture }).recordFromWebhook({
    providerCode: 'DELHIVERY', providerEventKey: 'evt-3', docType: 'EPOD', awb: 'AWB1',
    attachment: { kind: 'BASE64', value: Buffer.alloc(50, 3).toString('base64') }, // not a PNG/JPEG magic
  });
  assert.equal(capture.put, undefined);
  assert.equal(insertedCol(capture, 'image_status'), 'PENDING_FETCH');
});

await acheck('record_unmatched_awb_still_recorded', async () => {
  const capture = {};
  const decision = await makeService({ shipment: SHIPMENT, capture }).recordFromWebhook({
    providerCode: 'DELHIVERY', providerEventKey: 'evt-4', docType: 'EPOD', awb: 'WRONG-AWB',
    attachment: { kind: 'URL', value: 'https://carrier/x.png' },
  });
  assert.equal(decision, 'APPLIED');
  assert.equal(insertedCol(capture, 'shipment_id'), null);
  assert.equal(insertedCol(capture, 'link_status'), 'UNMATCHED_AWB');
});

await acheck('record_ref_mismatch_flagged_but_linked', async () => {
  const capture = {};
  await makeService({ shipment: SHIPMENT, capture }).recordFromWebhook({
    providerCode: 'DELHIVERY', providerEventKey: 'evt-5', docType: 'EPOD', awb: 'AWB1',
    providerOrderRef: 'SOME-OTHER-REF', attachment: { kind: 'URL', value: 'https://carrier/x.png' },
  });
  assert.equal(insertedCol(capture, 'shipment_id'), 'shp-1');
  assert.equal(insertedCol(capture, 'link_status'), 'REF_MISMATCH');
});

await acheck('record_replayed_webhook_is_one_row', async () => {
  const capture = {};
  const existing = [{ provider_code: 'DELHIVERY', provider_event_key: 'evt-dup', id: 'row-x' }];
  const decision = await makeService({ shipment: SHIPMENT, rows: existing, capture }).recordFromWebhook({
    providerCode: 'DELHIVERY', providerEventKey: 'evt-dup', docType: 'EPOD', awb: 'AWB1',
    attachment: { kind: 'URL', value: 'https://carrier/x.png' },
  });
  assert.equal(decision, 'IGNORED');
  assert.equal(capture.inserted, undefined);
});

await acheck('fetch_from_provider_resolves_pending_row', async () => {
  const capture = {};
  const pending = [{ id: 'row-p', provider_code: 'DELHIVERY', doc_type: 'EPOD', shipment_id: 'shp-1', awb: 'AWB1', image_status: 'PENDING_FETCH' }];
  const svc = makeService({
    shipment: SHIPMENT, rows: pending, capture,
    orchestrator: { async getDocuments() { return { available: true, url: 'https://s3/epod.pdf' }; } },
  });
  const r = await svc.fetchFromProvider({ shipmentId: 'shp-1', docType: 'EPOD' });
  assert.equal(r.available, true);
  assert.equal(r.imageStatus, 'LINKED_URL');
  assert.ok(capture.updated.some((u) => /image_status = 'LINKED_URL'/.test(u.sql)));
});

await acheck('fetch_from_provider_unavailable_marks_row', async () => {
  const capture = {};
  const pending = [{ id: 'row-p', provider_code: 'DELHIVERY', doc_type: 'EPOD', shipment_id: 'shp-1', awb: 'AWB1', image_status: 'PENDING_FETCH' }];
  const svc = makeService({
    shipment: SHIPMENT, rows: pending, capture,
    orchestrator: { async getDocuments() { return { available: false, url: null }; } },
  });
  const r = await svc.fetchFromProvider({ shipmentId: 'shp-1', docType: 'EPOD' });
  assert.equal(r.available, false);
  assert.ok(capture.updated.some((u) => /image_status = 'UNAVAILABLE'/.test(u.sql)));
});

await acheck('content_stored_integrity_check', async () => {
  const capture = {};
  const rows = [{ id: 'row-s', doc_type: 'EPOD', image_status: 'STORED', storage_key: '2026/00000000-0000-0000-0000-000000000000.png', sha256: 'deadbeef', content_type: 'image/png' }];
  // storage.get returns PNG whose sha256 != 'deadbeef' → integrity fails
  const svc = makeService({ shipment: SHIPMENT, rows, capture });
  await assert.rejects(() => svc.content('row-s'), (e) => e.code === 'CARRIER_DOCUMENT_INTEGRITY_FAILED');
  rows[0].image_status = 'LINKED_URL'; rows[0].image_url = 'https://carrier/x.png';
  const redir = await svc.content('row-s');
  assert.equal(redir.redirect, 'https://carrier/x.png');
});

// ---- mock adapter parity ------------------------------------
await acheck('mock_adapter_get_documents', async () => {
  const m = new MockShippingAdapter({ runtimeEnv: { SHIPPING_PROVIDER_MODE: 'MOCK' }, production: false });
  const r = await m.getDocuments({ awb: 'MOCKAWB1', docType: 'EPOD' });
  assert.equal(r.available, true);
  assert.match(r.url, /MOCKAWB1\/EPOD\.png$/);
  const u = await m.getDocuments({ awb: 'MOCKAWB1', docType: 'EPOD', simulateUnavailable: true });
  assert.equal(u.available, false);
});

console.log('\n──── Phase 2 · Slice 17 — carrier documents ────');
const failed = Object.entries(results).filter(([, v]) => String(v).startsWith('FAIL'));
console.log(`\nSHIPMENT_DOCUMENTS = ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length})`}`);
console.log('REAL_PROVIDER_CALLS = 0 (fixture-only)');
process.exitCode = failed.length === 0 ? 0 : 1;
