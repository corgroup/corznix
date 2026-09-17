// Delhivery adapter verification.
//
// Locally (no creds): fixture + error-normalization tests only, with a
// stubbed fetch — never touches the network.
// On staging (SHIPPING_PROVIDER_MODE=REAL + DELHIVERY_API_BASE_URL +
// DELHIVERY_API_TOKEN present): additionally runs ONE real serviceability
// call per test PIN through the adapter and asserts the normalized shape.
// It never books, never generates an AWB, never logs the token.
//
//   npm run verify:delhivery
import assert from 'node:assert/strict';

const { DelhiveryShippingAdapter } = await import('../src/modules/shipping/providers/delhiveryAdapter.js');
const { assertNormalizedProviderResult } = await import('../src/modules/shipping/providerContract.js');
const { env } = await import('../src/config/index.js');

const results = {};
const pass = (n) => { results[n] = 'PASS'; console.log(`  PASS  ${n}`); };

// Adapter with forced config so the fixture tests run regardless of env.
function stubbedAdapter(fetchImpl) {
  const adapter = new DelhiveryShippingAdapter({
    runtimeEnv: { SHIPPING_PROVIDER_MODE: 'REAL', DELHIVERY_API_BASE_URL: 'https://stub.delhivery.test', DELHIVERY_API_TOKEN: 'stub-token' },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  return { adapter, restore: () => { globalThis.fetch = realFetch; } };
}
const jsonResponse = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

try {
  // ---- real Delhivery shape: serviceable, COD + prepaid ----------------
  {
    const { adapter, restore } = stubbedAdapter(async () => jsonResponse({
      delivery_codes: [{ postal_code: { pin: 110001, inc: 'New Delhi', cod: 'Y', pre_paid: 'Y', pickup: 'Y', max_amount: 50000, is_oda: 'N' } }],
    }));
    const r = await adapter.quote({ destinationPostalCode: '110001' });
    restore();
    assertNormalizedProviderResult(r, 'DELHIVERY');
    assert.equal(r.serviceable, true);
    const s = r.services[0];
    assert.equal(s.providerServiceCode, 'PIN_SERVICEABILITY');
    assert.equal(s.codSupported, true);
    assert.equal(s.prepaidSupported, true);
    assert.equal(s.maxCodAmountMinor, 5000000, 'max_amount rupees -> paise');
    assert.equal(s.metadata.pickupSupported, true);
    assert.equal(s.metadata.rateUnavailable, true);
    pass('NORMALIZE_SERVICEABLE_REAL_SHAPE');
  }

  // ---- prepaid-only PIN -----------------------------------------------
  {
    const { adapter, restore } = stubbedAdapter(async () => jsonResponse({
      delivery_codes: [{ postal_code: { pin: 190001, cod: 'N', pre_paid: 'Y', max_amount: 0 } }],
    }));
    const r = await adapter.quote({ destinationPostalCode: '190001' });
    restore();
    assert.equal(r.serviceable, true);
    assert.equal(r.services[0].codSupported, false);
    assert.equal(r.services[0].prepaidSupported, true);
    assert.equal(r.services[0].maxCodAmountMinor, null);
    pass('NORMALIZE_PREPAID_ONLY');
  }

  // ---- unserviceable: empty delivery_codes ---------------------------
  {
    const { adapter, restore } = stubbedAdapter(async () => jsonResponse({ delivery_codes: [] }));
    const r = await adapter.quote({ destinationPostalCode: '999999' });
    restore();
    assert.equal(r.serviceable, false);
    assert.deepEqual(r.services, []);
    pass('NORMALIZE_UNSERVICEABLE');
  }

  // ---- unserviceable: neither cod nor prepaid ------------------------
  {
    const { adapter, restore } = stubbedAdapter(async () => jsonResponse({
      delivery_codes: [{ postal_code: { pin: 123456, cod: 'N', pre_paid: 'N' } }],
    }));
    const r = await adapter.quote({ destinationPostalCode: '123456' });
    restore();
    assert.equal(r.serviceable, false);
    pass('NORMALIZE_NO_PAYMENT_CAPABILITY');
  }

  // ---- backward-compat: bare array response -------------------------
  {
    const { adapter, restore } = stubbedAdapter(async () => jsonResponse([{ postal_code: { pin: 400001, cod: 'Y', pre_paid: 'Y' } }]));
    const r = await adapter.quote({ destinationPostalCode: '400001' });
    restore();
    assert.equal(r.serviceable, true);
    pass('NORMALIZE_BARE_ARRAY');
  }

  // ---- error normalization: 401 / 500 / malformed / network --------
  {
    const cases = [
      // Phase 2 §37 — auth failure is a distinct, actionable internal class.
      [async () => jsonResponse('Login or API Key Required', false, 401), /SHIPPING_PROVIDER_AUTH_FAILED/],
      [async () => jsonResponse('err', false, 429), /SHIPPING_PROVIDER_RATE_LIMITED/],
      [async () => jsonResponse('err', false, 400), /SHIPPING_PROVIDER_REJECTED/],
      [async () => jsonResponse('err', false, 503), /SHIPPING_PROVIDER_UNAVAILABLE/],
      [async () => jsonResponse({ unexpected: true }), /SHIPPING_PROVIDER_RESPONSE_INVALID/],
      [async () => { throw new Error('ECONNRESET'); }, /SHIPPING_PROVIDER_UNREACHABLE/],
    ];
    for (const [impl, re] of cases) {
      const { adapter, restore } = stubbedAdapter(impl);
      await assert.rejects(() => adapter.quote({ destinationPostalCode: '110001' }), re);
      restore();
    }
    pass('ERROR_NORMALIZATION');
  }

  // ---- not-configured guard ---------------------------------------
  {
    const adapter = new DelhiveryShippingAdapter({ runtimeEnv: { SHIPPING_PROVIDER_MODE: 'MOCK' } });
    assert.equal(adapter.configured, false);
    await assert.rejects(() => adapter.quote({ destinationPostalCode: '110001' }), /SHIPPING_PROVIDER_NOT_CONFIGURED/);
    pass('NOT_CONFIGURED_GUARD');
  }

  // ---- REAL call (staging only) ----------------------------------
  {
    const live = new DelhiveryShippingAdapter();
    if (!live.configured) {
      results.REAL_SERVICEABILITY = 'SKIPPED (SHIPPING_PROVIDER_MODE!=REAL or Delhivery creds absent)';
      console.log(`  SKIP  REAL_SERVICEABILITY — ${results.REAL_SERVICEABILITY}`);
    } else if (process.env.DELHIVERY_DIAGNOSTIC === '1') {
      // Raw one-shot probe (token never printed) — used to confirm the
      // endpoint/credential before trusting the adapter result.
      const base = String(env.DELHIVERY_API_BASE_URL).replace(/\/+$/, '');
      const r = await fetch(`${base}/c/api/pin-codes/json/?filter_codes=110001`, {
        headers: { Accept: 'application/json', Authorization: `Token ${env.DELHIVERY_API_TOKEN}` },
      });
      const body = (await r.text()).slice(0, 200).replace(/\s+/g, ' ');
      console.log(`  DIAG  HTTP ${r.status} ${r.statusText} · ct=${r.headers.get('content-type')} · body="${body}"`);
      results.REAL_SERVICEABILITY = `DIAGNOSTIC HTTP ${r.status}`;
    } else {
      let externalHost = null;
      const realFetch = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        const href = input instanceof URL ? input.href : (typeof input === 'string' ? input : input.url);
        externalHost = new URL(href).host;
        return realFetch(input, init);
      };
      const serviceablePin = process.env.DELHIVERY_TEST_SERVICEABLE_PIN || '110001';
      const invalidPin = process.env.DELHIVERY_TEST_INVALID_PIN || '999999';
      const started = Date.now();
      let okResult;
      let badResult;
      try {
        okResult = await live.quote({ destinationPostalCode: serviceablePin });
        badResult = await live.quote({ destinationPostalCode: invalidPin });
      } catch (err) {
        globalThis.fetch = realFetch;
        results.REAL_SERVICEABILITY = `FAIL (${err.message}) — check DELHIVERY_API_TOKEN / DELHIVERY_API_BASE_URL. Run with DELHIVERY_DIAGNOSTIC=1 for the raw HTTP status.`;
        console.log(`  FAIL  REAL_SERVICEABILITY — ${results.REAL_SERVICEABILITY}`);
        throw err;
      }
      globalThis.fetch = realFetch;

      assertNormalizedProviderResult(okResult, 'DELHIVERY');
      assert.equal(externalHost, new URL(env.DELHIVERY_API_BASE_URL).host, 'called only the configured Delhivery host');
      assert.equal(okResult.serviceable, true, `expected ${serviceablePin} serviceable`);
      assert.ok(typeof okResult.services[0].codSupported === 'boolean');
      assert.equal(badResult.serviceable, false, `expected ${invalidPin} unserviceable`);
      // No provider-native payload on the normalized result.
      assert.ok(!JSON.stringify(okResult).match(/delivery_codes|remark|country_code/i), 'no raw provider payload leaked');
      results.REAL_SERVICEABILITY = `PASS (serviceable=${serviceablePin} cod=${okResult.services[0].codSupported} prepaid=${okResult.services[0].prepaidSupported} durationMs=${Date.now() - started})`;
      console.log(`  PASS  REAL_SERVICEABILITY — ${results.REAL_SERVICEABILITY}`);
    }
  }

  console.log('\nDELHIVERY_ADAPTER_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nDELHIVERY_ADAPTER_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  const { pool } = await import('../src/database/connection/pool.js');
  await pool.end().catch(() => {});
}
