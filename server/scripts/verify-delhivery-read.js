// Phase 2 · Slice 9 — Delhivery READ adapter operations (TAT + shipping cost).
//
// Isolated fixture test (brief §51). global.fetch is stubbed — NO real provider
// call is made, and there is no runtime mock fallback anywhere in production.
//
//   * request fields + endpoints trace to Dev_API.docx
//   * mm -> cm conversion happens only in the adapter
//   * a response missing every plausible field FAILS LOUD (never a fabricated TAT/rate)
//   * auth / timeout / rejection map to the neutral error vocabulary
import assert from 'node:assert/strict';
import { DelhiveryShippingAdapter } from '../src/modules/shipping/providers/delhiveryAdapter.js';

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
const adapter = (env = REAL_ENV) => new DelhiveryShippingAdapter({ runtimeEnv: env });

let lastCall = null;
const stubFetch = (impl) => {
  global.fetch = async (url, options) => {
    lastCall = { url: new URL(url), options };
    return impl(lastCall);
  };
};
const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

await acheck('not_configured_guard', async () => {
  await assert.rejects(
    () => adapter({ SHIPPING_PROVIDER_MODE: 'MOCK' }).getTat({ originPostalCode: '201301', destinationPostalCode: '110001', mode: 'STANDARD' }),
    (e) => e.message === 'SHIPPING_PROVIDER_NOT_CONFIGURED',
  );
});

await acheck('get_tat_success', async () => {
  stubFetch(() => jsonResponse({ data: [{ tat: 4, expected_delivery_date: '2026-09-08' }] }));
  const r = await adapter().getTat({ originPostalCode: '201301', destinationPostalCode: '110001', mode: 'STANDARD' });
  assert.equal(r.providerCode, 'DELHIVERY');
  assert.equal(r.transitDays, 4);
  assert.equal(r.estimatedDeliveryDate, '2026-09-08');
  assert.equal(lastCall.url.pathname, '/api/dc/expected_tat');
  assert.equal(lastCall.url.searchParams.get('origin_pin'), '201301');
  assert.equal(lastCall.url.searchParams.get('mot'), 'S');
  assert.equal(lastCall.url.searchParams.get('pdt'), 'B2C');
  assert.equal(lastCall.options.headers.Authorization, 'Token test-token');
});

await acheck('get_tat_express_mot', async () => {
  stubFetch(() => jsonResponse([{ expected_tat: 2 }]));
  const r = await adapter().getTat({ originPostalCode: '201301', destinationPostalCode: '110001', mode: 'EXPRESS' });
  assert.equal(lastCall.url.searchParams.get('mot'), 'E');
  assert.equal(r.transitDays, 2);
});

await acheck('get_tat_unrecognized_response_fails_loud', async () => {
  stubFetch(() => jsonResponse({ status: 'ok', message: 'nothing useful' }));
  await assert.rejects(
    () => adapter().getTat({ originPostalCode: '201301', destinationPostalCode: '110001', mode: 'STANDARD' }),
    (e) => e.message === 'SHIPPING_PROVIDER_RESPONSE_INVALID',
  );
});

await acheck('get_shipping_quote_success', async () => {
  stubFetch(() => jsonResponse([{ total_amount: 76.5, charged_weight: 300 }]));
  const r = await adapter().getShippingQuote({
    originPostalCode: '201301', destinationPostalCode: '110001', mode: 'STANDARD',
    weightGrams: 280, paymentType: 'PREPAID', lengthMm: 300, widthMm: 220, heightMm: 50,
  });
  assert.equal(r.rateMinor, 7650);
  assert.equal(r.currency, 'INR');
  assert.equal(r.mode, 'STANDARD');
  assert.equal(lastCall.url.pathname, '/api/kinko/v1/invoice/charges/.json');
  assert.equal(lastCall.url.searchParams.get('md'), 'S');
  assert.equal(lastCall.url.searchParams.get('cgm'), '280');
  assert.equal(lastCall.url.searchParams.get('pt'), 'Pre-paid');
  assert.equal(lastCall.url.searchParams.get('ss'), 'Delivered');
  assert.equal(lastCall.url.searchParams.get('l'), '30'); // 300mm -> 30cm, adapter-only
  assert.equal(lastCall.url.searchParams.get('b'), '22');
});

await acheck('get_shipping_quote_express_and_cod', async () => {
  stubFetch(() => jsonResponse({ data: { total: 220 } }));
  const r = await adapter().getShippingQuote({
    originPostalCode: '201301', destinationPostalCode: '110001', mode: 'EXPRESS', weightGrams: 500, paymentType: 'COD',
  });
  assert.equal(lastCall.url.searchParams.get('md'), 'E');
  assert.equal(lastCall.url.searchParams.get('pt'), 'COD');
  assert.equal(r.rateMinor, 22000);
  assert.equal(r.mode, 'EXPRESS');
});

await acheck('get_shipping_quote_bad_weight_rejected', async () => {
  await assert.rejects(
    () => adapter().getShippingQuote({ originPostalCode: '201301', destinationPostalCode: '110001', mode: 'STANDARD', weightGrams: 0 }),
    (e) => e.message === 'SHIPPING_PROVIDER_REQUEST_INVALID',
  );
});

await acheck('get_shipping_quote_no_amount_fails_loud', async () => {
  stubFetch(() => jsonResponse([{ some_other_field: 1 }]));
  await assert.rejects(
    () => adapter().getShippingQuote({ originPostalCode: '201301', destinationPostalCode: '110001', mode: 'STANDARD', weightGrams: 280 }),
    (e) => e.message === 'SHIPPING_PROVIDER_RESPONSE_INVALID',
  );
});

await acheck('auth_failure_mapped', async () => {
  stubFetch(() => jsonResponse({ error: 'unauthorized' }, 401));
  await assert.rejects(
    () => adapter().getTat({ originPostalCode: '201301', destinationPostalCode: '110001', mode: 'STANDARD' }),
    (e) => e.message === 'SHIPPING_PROVIDER_AUTH_FAILED',
  );
});

await acheck('timeout_mapped', async () => {
  global.fetch = async (url, options) => {
    await new Promise((resolve, reject) => { options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });
  };
  await assert.rejects(
    () => adapter({ ...REAL_ENV, SHIPPING_PROVIDER_TIMEOUT_MS: 20 }).getTat({ originPostalCode: '201301', destinationPostalCode: '110001', mode: 'STANDARD' }),
    (e) => e.message === 'SHIPPING_PROVIDER_TIMEOUT',
  );
});

await acheck('no_raw_provider_body_in_errors', async () => {
  stubFetch(() => jsonResponse({ secret_internal: 'PROVIDER DEBUG STRING' }, 500));
  await adapter().getTat({ originPostalCode: '201301', destinationPostalCode: '110001', mode: 'STANDARD' }).then(
    () => { throw new Error('should have thrown'); },
    (e) => { assert.ok(!/PROVIDER DEBUG STRING/.test(e.message)); assert.equal(e.message, 'SHIPPING_PROVIDER_UNAVAILABLE'); },
  );
});

console.log('\n──── Phase 2 · Slice 9 — Delhivery read adapter ────');
const failed = Object.entries(results).filter(([, v]) => String(v).startsWith('FAIL'));
console.log(`\nDELHIVERY_READ = ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length})`}`);
console.log('REAL_PROVIDER_CALLS = 0 (fixture-only)');
process.exitCode = failed.length === 0 ? 0 : 1;
