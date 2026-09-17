// Shared provider-platform skeleton characterization — Provider Platform
// Migration, Phase 2.
//
// The skeleton (server/src/platform/shared/) is additive: importing it changes
// no runtime behaviour, and no capability is migrated onto it yet. This script
// pins the contract of every primitive so Phase 3+ can build on a frozen base.
//
// Pure: no DB, no network (global fetch is stubbed only for the providerHttp
// tests and restored).
//
//   npm run verify:platform
import assert from 'node:assert/strict';

const { AppError } = await import('../src/utils/errors.js');
const {
  ProviderError,
  PROVIDER_ERROR_CODES,
  createProviderError,
  providerErrorFromHttpStatus,
  providerErrorToAppError,
  CAPABILITIES,
  assertAdapterConformance,
  createProviderRegistry,
  providerRegistry,
  staticConfigSource,
  setProviderConfigSource,
  getProviderConfig,
  getEnabledProviders,
  isProviderEnabled,
  redact,
  logProviderCall,
  withProviderCall,
  providerFetch,
  providerFetchJson,
} = await import('../src/platform/shared/index.js');

const results = {};
const pass = (name) => { results[name] = 'PASS'; console.log(`  PASS  ${name}`); };
const realFetch = globalThis.fetch;

try {
  // ---- providerError --------------------------------------------------
  {
    const rl = createProviderError({ code: PROVIDER_ERROR_CODES.RATE_LIMITED, providerKey: 'x' });
    assert.ok(rl instanceof ProviderError);
    assert.equal(rl.retryable, true, 'RATE_LIMITED retryable by default');
    assert.equal(createProviderError({ code: PROVIDER_ERROR_CODES.PROVIDER_AUTH_FAILED }).retryable, false);
    assert.equal(createProviderError({ code: PROVIDER_ERROR_CODES.PROVIDER_AUTH_FAILED, retryable: true }).retryable, true, 'explicit wins');
    assert.equal(createProviderError(rl), rl, 'createProviderError is idempotent on a ProviderError');
    pass('PROVIDER_ERROR_RETRYABLE_DEFAULTS');
  }
  {
    const cases = [[429, 'RATE_LIMITED'], [401, 'PROVIDER_AUTH_FAILED'], [403, 'PROVIDER_AUTH_FAILED'], [400, 'PROVIDER_VALIDATION_FAILED'], [422, 'PROVIDER_VALIDATION_FAILED'], [500, 'PROVIDER_UNAVAILABLE'], [503, 'PROVIDER_UNAVAILABLE'], [418, 'PROVIDER_ERROR']];
    for (const [status, code] of cases) {
      const err = providerErrorFromHttpStatus(status, { providerKey: 'p', capability: 'media' });
      assert.equal(err.code, code, `HTTP ${status} -> ${code}`);
      assert.equal(err.meta.httpStatus, status);
    }
    pass('PROVIDER_ERROR_FROM_HTTP_STATUS');
  }
  {
    const err = createProviderError({ code: PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE, providerKey: 'p', capability: 'media', cause: new Error('boom'), meta: { secret: 'hunter2' } });
    const json = JSON.parse(JSON.stringify(err));
    assert.deepEqual(Object.keys(json).sort(), ['capability', 'code', 'name', 'providerKey', 'retryable']);
    assert.ok(!('cause' in json) && !('meta' in json), 'toJSON omits cause + meta');
    pass('PROVIDER_ERROR_TOJSON_IS_SAFE');
  }
  {
    assert.ok(providerErrorToAppError({ code: PROVIDER_ERROR_CODES.RATE_LIMITED }) instanceof AppError);
    assert.equal(providerErrorToAppError({ code: PROVIDER_ERROR_CODES.RATE_LIMITED }).status, 503);
    assert.equal(providerErrorToAppError({ code: PROVIDER_ERROR_CODES.RATE_LIMITED }).code, 'PROVIDER_RATE_LIMITED');
    assert.equal(providerErrorToAppError({ code: PROVIDER_ERROR_CODES.PROVIDER_AUTH_FAILED }).code, 'PROVIDER_UNAVAILABLE', 'auth detail never leaks');
    assert.equal(providerErrorToAppError({ code: PROVIDER_ERROR_CODES.PROVIDER_RESPONSE_INVALID }).status, 502);
    pass('PROVIDER_ERROR_TO_APP_ERROR');
  }

  // ---- adapterContract ----------------------------------------------
  {
    const media = { upload() {}, remove() {} };
    assert.equal(assertAdapterConformance(media, { capability: CAPABILITIES.MEDIA, providerKey: 'ok' }), media);

    assert.throws(
      () => assertAdapterConformance({ upload() {} }, { capability: CAPABILITIES.MEDIA, providerKey: 'partial' }),
      (err) => err instanceof ProviderError && err.code === PROVIDER_ERROR_CODES.PROVIDER_MISCONFIGURED && /remove/.test(err.message),
    );
    assert.throws(
      () => assertAdapterConformance({}, { capability: 'made-up' }),
      (err) => err.code === PROVIDER_ERROR_CODES.PROVIDER_MISCONFIGURED && /unknown capability/.test(err.message),
    );
    assert.equal(
      assertAdapterConformance({ ping() {} }, { capability: 'made-up', requiredMethods: ['ping'] }).ping.name,
      'ping',
      'explicit requiredMethods override',
    );
    pass('ADAPTER_CONFORMANCE');
  }

  // ---- providerRegistry --------------------------------------------
  {
    const registry = createProviderRegistry();
    const adapter = { quote() {} };
    assert.equal(registry.register('logistics', 'ACME', adapter), adapter);
    assert.equal(registry.get('logistics', 'ACME'), adapter);
    assert.equal(registry.has('logistics', 'ACME'), true);
    assert.equal(registry.tryGet('logistics', 'NOPE'), null);

    assert.throws(() => registry.get('logistics', 'NOPE'), (err) => err.code === PROVIDER_ERROR_CODES.PROVIDER_NOT_CONFIGURED);
    assert.throws(
      () => registry.register('logistics', 'BROKEN', { notQuote() {} }),
      (err) => err.code === PROVIDER_ERROR_CODES.PROVIDER_MISCONFIGURED,
    );

    registry.register('media', 'cloudinary', { upload() {}, remove() {} });
    assert.deepEqual(registry.list('logistics').map((e) => e.providerKey).sort(), ['ACME']);
    assert.equal(registry.list().length, 2);
    assert.equal(registry.unregister('logistics', 'ACME'), true);
    assert.equal(registry.has('logistics', 'ACME'), false);
    registry.clear();
    assert.equal(registry.list().length, 0);

    assert.equal(providerRegistry.list().length, 0, 'the process singleton ships empty (no behaviour change in Phase 2)');
    pass('PROVIDER_REGISTRY');
  }

  // ---- providerConfig --------------------------------------------
  {
    const cloudinary = await getProviderConfig('media', 'cloudinary');
    assert.equal(cloudinary.enabled, true);
    assert.equal(cloudinary.source, 'DEFAULT');
    assert.equal(cloudinary.version, 0);
    assert.deepEqual(cloudinary.config, {});

    assert.equal((await getProviderConfig('media', 'ghost')).enabled, false);
    assert.equal(await isProviderEnabled('payments', 'CASHFREE'), true);

    const logistics = await getEnabledProviders('logistics');
    assert.deepEqual(logistics.map((e) => e.providerKey), ['DELHIVERY', 'BLUE_DART', 'DTDC', 'MOCK'], 'ordered by ascending priority');
    pass('PROVIDER_CONFIG_STATIC_SOURCE');
  }
  {
    setProviderConfigSource({
      get: async (capability, providerKey) => ({ capability, providerKey, enabled: providerKey === 'ON', priority: 5, config: { region: 'ap-south-1' }, version: 42, source: 'TEST' }),
      list: async () => [
        { capability: 'media', providerKey: 'ON', enabled: true, priority: 5, config: {}, version: 42, source: 'TEST' },
        { capability: 'media', providerKey: 'OFF', enabled: false, priority: 1, config: {}, version: 42, source: 'TEST' },
      ],
    });
    const swapped = await getProviderConfig('media', 'ON');
    assert.equal(swapped.source, 'TEST');
    assert.equal(swapped.version, 42);
    assert.deepEqual(swapped.config, { region: 'ap-south-1' });
    assert.deepEqual((await getEnabledProviders('media')).map((e) => e.providerKey), ['ON']);
    setProviderConfigSource(staticConfigSource);
    assert.equal((await getProviderConfig('media', 'cloudinary')).source, 'DEFAULT', 'source restored');
    pass('PROVIDER_CONFIG_SOURCE_IS_PLUGGABLE');
  }

  // ---- providerLogging: redaction -------------------------------
  {
    const scrubbed = redact({
      to: '+9199xxxxxx',
      otp: '4821',
      headers: { authorization: 'Bearer abc', 'content-type': 'application/json' },
      nested: [{ apiKey: 'k', ok: 1 }],
      password: 'p',
      cf_client_secret: 's',
    });
    assert.equal(scrubbed.otp, '***');
    assert.equal(scrubbed.headers.authorization, '***');
    assert.equal(scrubbed.headers['content-type'], 'application/json');
    assert.equal(scrubbed.nested[0].apiKey, '***');
    assert.equal(scrubbed.nested[0].ok, 1);
    assert.equal(scrubbed.password, '***');
    assert.equal(scrubbed.cf_client_secret, '***');
    assert.equal(scrubbed.to, '+9199xxxxxx');
    const circular = {}; circular.self = circular;
    assert.doesNotThrow(() => redact(circular));
    pass('PROVIDER_LOGGING_REDACTS_SECRETS');
  }

  // ---- providerLogging: logProviderCall + withProviderCall ------
  {
    const lines = [];
    const fakeLogger = { info: (l) => lines.push(['info', l]), warn: (l) => lines.push(['warn', l]) };

    logProviderCall({ capability: 'media', providerKey: 'cloudinary', operation: 'upload', outcome: 'SUCCESS', durationMs: 12, correlationId: 'req-1' }, fakeLogger);
    assert.equal(lines[0][0], 'info');
    assert.match(lines[0][1], /^\[provider\] capability=media provider=cloudinary op=upload outcome=SUCCESS durationMs=12 correlationId=req-1$/);

    const value = await withProviderCall({ capability: 'media', providerKey: 'p', operation: 'ping' }, async () => 7, fakeLogger);
    assert.equal(value, 7);
    assert.equal(lines[1][0], 'info');

    // a plain Error is normalized into a ProviderError(PROVIDER_ERROR)
    await assert.rejects(
      () => withProviderCall({ capability: 'media', providerKey: 'p', operation: 'boom' }, async () => { throw new Error('raw'); }, fakeLogger),
      (err) => err instanceof ProviderError && err.code === PROVIDER_ERROR_CODES.PROVIDER_ERROR && err.cause?.message === 'raw',
    );
    assert.equal(lines[2][0], 'warn');
    assert.match(lines[2][1], /outcome=ERROR .*errorCode=PROVIDER_ERROR/);

    // an existing ProviderError passes through untouched
    const passed = createProviderError({ code: PROVIDER_ERROR_CODES.RATE_LIMITED, providerKey: 'p' });
    await assert.rejects(
      () => withProviderCall({ capability: 'media', providerKey: 'p', operation: 'x' }, async () => { throw passed; }, fakeLogger),
      (err) => err === passed,
    );
    assert.match(lines[3][1], /outcome=RETRYABLE_ERROR .*errorCode=RATE_LIMITED/);
    pass('PROVIDER_LOGGING_WITH_PROVIDER_CALL');
  }

  // ---- providerHttp -------------------------------------------
  {
    globalThis.fetch = (_url, { signal } = {}) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    await assert.rejects(
      () => providerFetch('https://slow.test', { timeoutMs: 20, providerKey: 'p', capability: 'media' }),
      (err) => err instanceof ProviderError && err.code === PROVIDER_ERROR_CODES.PROVIDER_TIMEOUT,
    );

    globalThis.fetch = () => Promise.reject(new TypeError('fetch failed'));
    await assert.rejects(
      () => providerFetch('https://down.test', { providerKey: 'p' }),
      (err) => err.code === PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE,
    );

    globalThis.fetch = () => Promise.resolve(new Response('nope', { status: 429 }));
    await assert.rejects(
      () => providerFetch('https://limited.test', { providerKey: 'p' }),
      (err) => err.code === PROVIDER_ERROR_CODES.RATE_LIMITED,
    );

    globalThis.fetch = () => Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    const ok = await providerFetch('https://good.test');
    assert.equal(ok.status, 200);
    assert.deepEqual(await providerFetchJson('https://good.test'), { ok: true });

    globalThis.fetch = () => Promise.resolve(new Response('<<not json>>', { status: 200 }));
    await assert.rejects(
      () => providerFetchJson('https://weird.test', { providerKey: 'p' }),
      (err) => err.code === PROVIDER_ERROR_CODES.PROVIDER_RESPONSE_INVALID,
    );
    pass('PROVIDER_HTTP_NORMALIZES_OUTCOMES');
  }

  console.log('\nPLATFORM_SKELETON_CHARACTERIZATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nPLATFORM_SKELETON_CHARACTERIZATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
}
