// Wave 8I — provider & platform operations characterization.
//
// Proves the OPERATIONAL plane without a single real provider call:
//   - non-secret config guard (secret/endpoint keys rejected), config
//     versioning + immutable revisions + rollback, enable-with-missing-secret
//     refused
//   - adapter conformance (missing method → registration denied)
//   - health state machine (NOT_CONFIGURED / MISCONFIGURED / UNAVAILABLE /
//     DEGRADED / HEALTHY / UNKNOWN) derived purely from attempt evidence
//   - webhook inbox: signature reject (no business effect), dedupe (one
//     application), replay idempotency, replay-of-applied refused
//   - outbox: transactional enqueue, double-worker claim (SKIP LOCKED),
//     retry classification + bounded backoff, AMBIGUOUS → reconciliation +
//     no blind retry, NON_RETRYABLE → dead
//   - normalized error vocabulary + correlation ids
//   - secret scan of the config table
// Self-cleaning — TEST_RESIDUE = 0.
//
//   npm run verify:platform-ops
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';
process.env.COMMUNICATION_WORKER_ENABLED = 'false';
process.env.PLATFORM_OUTBOX_WORKER_ENABLED = 'false';

const realFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = (...a) => { networkCalls += 1; return realFetch?.(...a); };

const { pool, query } = await import('../src/database/connection/pool.js');
const { withTransaction } = await import('../src/database/connection/transaction.js');
const { assertAdapterConformance } = await import('../src/platform/shared/adapterContract.js');
const { roleHasPermission } = await import('../src/modules/staff/permissions.js');
const { PROVIDERS, secretStatus } = await import('../src/modules/platform/capabilities.js');
const { platformRepository: R } = await import('../src/modules/platform/repository.js');
const { providerConfigService, dbProviderConfigSource } = await import('../src/modules/platform/providerConfigService.js');
const { providerHealthService } = await import('../src/modules/platform/providerHealthService.js');
const { normalizeErrorCode, NORMALIZED_ERROR } = await import('../src/modules/platform/normalizedErrors.js');
const {
  webhookInboxService, registerWebhookVerifier, registerWebhookParser,
  registerWebhookApplier, _resetWebhookRegistries,
} = await import('../src/modules/platform/webhookInboxService.js');
const {
  enqueue, processDue, outboxService, registerOutboxHandler, _resetOutboxHandlers, backoffMs,
} = await import('../src/modules/platform/outboxService.js');

const results = {};
const pass = (name) => { results[name] = 'PASS'; console.log(`  PASS  ${name}`); };
const fail = (name, e) => { results[name] = `FAIL: ${e?.message || e}`; console.error(`  FAIL  ${name}: ${e?.message || e}`); };
const run = async (name, fn) => { try { await fn(); pass(name); } catch (e) { fail(name, e); } };

const [defaultBrand] = await query('SELECT id FROM brands WHERE is_default = 1 LIMIT 1');
if (!defaultBrand) throw new Error('no default brand — run the migrations and seed first');
const BRAND_ID = defaultBrand.id;

const TAG = randomUUID().slice(0, 8);
const HEALTH_CAP = 'payments';
const HEALTH_KEY = 'MOCK_PAYMENT';   // secretEnv [] → CONFIGURED
const WH_CAP = 'payments';
const WH_KEY = 'MOCK_PAYMENT';       // webhookCapable
const touchedConfigs = new Set();

async function clearAttempts(cap, key) { await query('DELETE FROM provider_attempts WHERE capability = ? AND provider_key = ?', [cap, key]); }
async function insertAttempt(cap, key, outcome, code) {
  await R.insertAttempt({
    correlationId: `vpo-${TAG}-${randomUUID().slice(0, 8)}`, capability: cap, providerKey: key,
    operation: 'probe', outcome, normalizedErrorCode: code ?? null, durationMs: 12, startedAt: new Date(),
  });
}

try {
  // ---- 1. non-secret config guard --------------------------------
  await run('config_rejects_secret_key', async () => {
    await assert.rejects(
      () => providerConfigService.update({ capability: 'media', providerKey: 'cloudinary', config: { api_key: 'x' }, staffId: null }),
      { code: 'PROVIDER_CONFIG_FORBIDDEN_KEY' });
    await assert.rejects(
      () => providerConfigService.update({ capability: 'media', providerKey: 'cloudinary', config: { token: 'x' }, staffId: null }),
      { code: 'PROVIDER_CONFIG_FORBIDDEN_KEY' });
  });
  await run('config_rejects_endpoint_value', async () => {
    await assert.rejects(
      () => providerConfigService.update({ capability: 'media', providerKey: 'cloudinary', config: { region: 'https://evil.example.com' }, staffId: null }),
      (e) => ['PROVIDER_CONFIG_FORBIDDEN_KEY', 'PROVIDER_CONFIG_FORBIDDEN_VALUE'].includes(e.code));
  });

  // ---- 2. config versioning + revisions + rollback --------------
  await run('config_versioning_and_rollback', async () => {
    touchedConfigs.add(`${HEALTH_CAP}:${HEALTH_KEY}`);
    const v1 = await providerConfigService.update({ capability: HEALTH_CAP, providerKey: HEALTH_KEY, priority: 500, config: { note: 'v-a' }, staffId: null });
    const v2 = await providerConfigService.update({ capability: HEALTH_CAP, providerKey: HEALTH_KEY, priority: 400, config: { note: 'v-b' }, staffId: null });
    assert.equal(v2.version, v1.version + 1, 'version bumps');
    const revs = await R.revisions(HEALTH_CAP, HEALTH_KEY);
    assert.ok(revs.length >= 2, 'immutable revisions recorded');
    const back = await providerConfigService.rollback({ capability: HEALTH_CAP, providerKey: HEALTH_KEY, toVersion: v1.version, staffId: null });
    assert.equal(back.version, v2.version + 1, 'rollback is a NEW forward revision');
    assert.equal(back.priority, 500, 'rollback restored the old non-secret value');
  });

  // ---- 3. enable-with-missing-secret refused (§118) -------------
  await run('enable_with_missing_secret_refused', async () => {
    const missing = PROVIDERS.find((p) => secretStatus(p.capability, p.providerKey) === 'NOT_CONFIGURED');
    if (!missing) { results.enable_with_missing_secret_refused = 'SKIP: every catalogued provider has credentials in this env'; console.log('  SKIP  enable_with_missing_secret_refused'); return; }
    touchedConfigs.add(`${missing.capability}:${missing.providerKey}`);
    await assert.rejects(
      () => providerConfigService.update({ capability: missing.capability, providerKey: missing.providerKey, enabled: true, staffId: null }),
      (e) => e.code === 'PROVIDER_NOT_CONFIGURED');
  });

  // ---- 4. adapter conformance ---------------------------------
  await run('adapter_conformance_denies_missing_method', async () => {
    assert.throws(() => assertAdapterConformance({ upload() {} }, { capability: 'media', providerKey: 'broken' }), /missing method/);
    assert.doesNotThrow(() => assertAdapterConformance({ upload() {}, remove() {} }, { capability: 'media', providerKey: 'ok' }));
  });

  // ---- 5. health state machine -------------------------------
  const healthAlertsSince = new Date(Date.now() - 1000);
  await run('health_UNKNOWN_without_evidence', async () => {
    await clearAttempts(HEALTH_CAP, HEALTH_KEY);
    const h = await providerHealthService.recompute(HEALTH_CAP, HEALTH_KEY);
    assert.equal(h.status, 'UNKNOWN');
  });
  await run('health_MISCONFIGURED_on_all_auth_failures', async () => {
    await clearAttempts(HEALTH_CAP, HEALTH_KEY);
    for (let i = 0; i < 4; i += 1) await insertAttempt(HEALTH_CAP, HEALTH_KEY, 'FAILURE', 'PROVIDER_AUTH_FAILED');
    const h = await providerHealthService.recompute(HEALTH_CAP, HEALTH_KEY);
    assert.equal(h.status, 'MISCONFIGURED');
  });
  await run('health_UNAVAILABLE_on_non_auth_failures', async () => {
    await clearAttempts(HEALTH_CAP, HEALTH_KEY);
    for (let i = 0; i < 3; i += 1) await insertAttempt(HEALTH_CAP, HEALTH_KEY, 'FAILURE', 'PROVIDER_UNAVAILABLE');
    const h = await providerHealthService.recompute(HEALTH_CAP, HEALTH_KEY);
    assert.equal(h.status, 'UNAVAILABLE');
  });
  await run('health_DEGRADED_then_HEALTHY', async () => {
    await clearAttempts(HEALTH_CAP, HEALTH_KEY);
    for (let i = 0; i < 2; i += 1) await insertAttempt(HEALTH_CAP, HEALTH_KEY, 'SUCCESS', null);
    for (let i = 0; i < 3; i += 1) await insertAttempt(HEALTH_CAP, HEALTH_KEY, 'FAILURE', 'PROVIDER_UNAVAILABLE');
    assert.equal((await providerHealthService.recompute(HEALTH_CAP, HEALTH_KEY)).status, 'DEGRADED');
    await clearAttempts(HEALTH_CAP, HEALTH_KEY);
    for (let i = 0; i < 9; i += 1) await insertAttempt(HEALTH_CAP, HEALTH_KEY, 'SUCCESS', null);
    await insertAttempt(HEALTH_CAP, HEALTH_KEY, 'FAILURE', 'PROVIDER_UNAVAILABLE');
    const h = await providerHealthService.recompute(HEALTH_CAP, HEALTH_KEY);
    assert.equal(h.status, 'HEALTHY');
    assert.ok(h.avgLatencyMs != null, 'latency visibility');
    assert.ok(h.lastSuccessAt && h.lastFailureAt, 'last success + last failure');
  });
  await run('health_changes_alert_staff', async () => {
    // Each change above that staff must act on reached the CMS bell as a
    // SYSTEM notification, and so did the recovery; the first reading (no
    // previous status) did not. A disabled provider alerts nobody.
    const { enabled } = await dbProviderConfigSource.get(HEALTH_CAP, HEALTH_KEY);
    const rows = await query(
      "SELECT event_key, severity, category, link FROM staff_notifications WHERE entity_type = 'provider' AND entity_id = ? AND created_at >= ? ORDER BY created_at",
      [`${HEALTH_CAP}:${HEALTH_KEY}`, healthAlertsSince]);
    const expected = enabled
      ? ['PROVIDER_MISCONFIGURED/CRITICAL', 'PROVIDER_UNAVAILABLE/CRITICAL', 'PROVIDER_DEGRADED/WARNING', 'PROVIDER_HEALTHY/INFO']
      : [];
    assert.deepEqual(rows.map((r) => `${r.event_key}/${r.severity}`), expected);
    assert.ok(rows.every((r) => r.category === 'SYSTEM' && r.link === '/platform/providers'), 'SYSTEM rows linking to Providers');
  });
  await run('health_does_not_mutate_business_data', async () => {
    // recompute writes provider_health / provider_health_events, and a staff
    // notification on a change that needs attention — never business data.
    const before = await query('SELECT COUNT(*) n FROM orders');
    await providerHealthService.recompute(HEALTH_CAP, HEALTH_KEY);
    const after = await query('SELECT COUNT(*) n FROM orders');
    assert.equal(Number(before[0].n), Number(after[0].n));
  });

  // ---- 6. webhook inbox -------------------------------------
  let applyCalls = 0;
  let applierMode = 'APPLIED';
  const setupWebhook = () => {
    _resetWebhookRegistries();
    registerWebhookVerifier(WH_CAP, WH_KEY, (raw, headers) => headers['x-sig'] === 'good');
    registerWebhookParser(WH_CAP, WH_KEY, (p) => ({ providerEventId: p.id, normalizedEventType: p.kind, resourceType: 'payment', resourceId: p.ref, safeSummary: { kind: p.kind } }));
    registerWebhookApplier(WH_CAP, async () => {
      applyCalls += 1;
      if (applierMode === 'THROW') throw Object.assign(new Error('bad state'), { code: 'PROVIDER_VALIDATION_FAILED' });
      return applierMode;
    });
  };

  await run('webhook_rejects_bad_signature_no_business_effect', async () => {
    setupWebhook(); applyCalls = 0;
    const body = JSON.stringify({ id: `e-${TAG}-r`, kind: 'paid', ref: 'o1' });
    const res = await webhookInboxService.ingest({ capability: WH_CAP, providerKey: WH_KEY, rawBody: body, headers: { 'x-sig': 'bad' } });
    assert.equal(res.status, 'REJECTED');
    assert.equal(res.businessEffect, false);
    assert.equal(applyCalls, 0, 'applier never runs for a rejected webhook');
  });

  await run('webhook_dedupe_one_application', async () => {
    setupWebhook(); applyCalls = 0; applierMode = 'APPLIED';
    const body = JSON.stringify({ id: `e-${TAG}-d`, kind: 'paid', ref: 'o2' });
    const first = await webhookInboxService.ingest({ capability: WH_CAP, providerKey: WH_KEY, rawBody: body, headers: { 'x-sig': 'good' } });
    const second = await webhookInboxService.ingest({ capability: WH_CAP, providerKey: WH_KEY, rawBody: body, headers: { 'x-sig': 'good' } });
    assert.equal(first.status, 'APPLIED');
    assert.equal(second.status, 'DUPLICATE');
    assert.equal(applyCalls, 1, 'exactly one business application for a duplicated event');
  });

  await run('webhook_replay_idempotency', async () => {
    setupWebhook(); applyCalls = 0; applierMode = 'THROW';
    const body = JSON.stringify({ id: `e-${TAG}-p`, kind: 'paid', ref: 'o3' });
    const ingested = await webhookInboxService.ingest({ capability: WH_CAP, providerKey: WH_KEY, rawBody: body, headers: { 'x-sig': 'good' } });
    assert.equal(ingested.status, 'FAILED');
    applierMode = 'APPLIED';
    const replay1 = await webhookInboxService.replay(ingested.id);
    assert.equal(replay1.status, 'REPLAYED');
    assert.equal(replay1.businessEffect, true);
    await assert.rejects(() => webhookInboxService.replay(ingested.id), { code: 'WEBHOOK_ALREADY_APPLIED' });
  });

  await run('webhook_parse_failure_persisted', async () => {
    setupWebhook();
    const res = await webhookInboxService.ingest({ capability: WH_CAP, providerKey: WH_KEY, rawBody: '{not json', headers: { 'x-sig': 'good' } });
    assert.equal(res.status, 'FAILED');
    const row = await R.inboxById(res.id);
    assert.equal(row.processing_status, 'FAILED');
    assert.equal(row.last_error_code, NORMALIZED_ERROR.PROVIDER_VALIDATION_FAILED);
  });
  _resetWebhookRegistries();

  // ---- 7. outbox ------------------------------------------
  await run('outbox_transactional_enqueue', async () => {
    const id = await withTransaction((tx) => enqueue(tx, { brandId: BRAND_ID, eventType: `vpo.noop.${TAG}`, aggregateType: 'test', aggregateId: TAG, payload: { a: 1 } }));
    const row = await R.outboxById(id);
    assert.equal(row.status, 'PENDING');
    assert.equal(row.correlation_id?.startsWith('ob-'), true);
  });

  await run('outbox_worker_success', async () => {
    _resetOutboxHandlers();
    let handled = 0;
    registerOutboxHandler(`vpo.ok.${TAG}`, async () => { handled += 1; });
    const id = await withTransaction((tx) => enqueue(tx, { brandId: BRAND_ID, eventType: `vpo.ok.${TAG}`, payload: {} }));
    await processDue({ workerId: `w-${TAG}`, batch: 50 });
    assert.equal(handled, 1);
    assert.equal((await R.outboxById(id)).status, 'PROCESSED');
  });

  await run('outbox_double_worker_single_claim', async () => {
    _resetOutboxHandlers();
    const id = await withTransaction((tx) => enqueue(tx, { brandId: BRAND_ID, eventType: `vpo.claim.${TAG}`, payload: {} }));
    const [a, b] = await Promise.all([
      withTransaction((tx) => R.claimOutbox(tx, 'worker-a', 10)),
      withTransaction((tx) => R.claimOutbox(tx, 'worker-b', 10)),
    ]);
    const claims = [...a, ...b].filter((x) => x === id);
    assert.equal(claims.length, 1, 'exactly one worker claims the row (SKIP LOCKED)');
    await R.finishOutbox(id, { status: 'CANCELLED' });
  });

  await run('outbox_retry_classification_and_backoff', async () => {
    _resetOutboxHandlers();
    let attempts = 0;
    registerOutboxHandler(`vpo.retry.${TAG}`, async () => {
      attempts += 1;
      if (attempts < 2) throw Object.assign(new Error('transient'), { code: 'PROVIDER_UNAVAILABLE' });
    });
    const id = await withTransaction((tx) => enqueue(tx, { brandId: BRAND_ID, eventType: `vpo.retry.${TAG}`, payload: {} }));
    const r1 = await processDue({ workerId: `w-${TAG}`, batch: 50 });
    assert.ok(r1.some((x) => x.id === id && x.status === 'FAILED'), 'safe-retry → FAILED + reschedule');
    let row = await R.outboxById(id);
    assert.ok(row.next_attempt_at, 'bounded backoff scheduled a next attempt');
    assert.equal(Number(row.attempt_count), 1);
    await query('UPDATE platform_outbox SET next_attempt_at = DATE_SUB(NOW(3), INTERVAL 1 SECOND) WHERE id = ?', [id]);
    await processDue({ workerId: `w-${TAG}`, batch: 50 });
    row = await R.outboxById(id);
    assert.equal(row.status, 'PROCESSED', 'eventual success');
    assert.ok(backoffMs(1) > 0 && backoffMs(6) <= 15 * 60 * 1000 + 500, 'backoff is bounded');
  });

  await run('outbox_ambiguous_reconciliation_no_blind_retry', async () => {
    _resetOutboxHandlers();
    registerOutboxHandler(`vpo.amb.${TAG}`, async () => { throw Object.assign(new Error('timeout'), { code: 'PROVIDER_TIMEOUT' }); });
    const id = await withTransaction((tx) => enqueue(tx, {
      brandId: BRAND_ID, eventType: `vpo.amb.${TAG}`, aggregateType: 'payment', aggregateId: `amb-${TAG}`,
      payload: { capability: 'payments', providerKey: 'MOCK_PAYMENT' },
    }));
    await processDue({ workerId: `w-${TAG}`, batch: 50 });
    const row = await R.outboxById(id);
    assert.equal(row.status, 'RECONCILIATION_REQUIRED', 'ambiguous outcome is NOT blindly retried');
    const exc = await query("SELECT * FROM reconciliation_exceptions WHERE source_domain = 'provider' AND reference_id = ?", [`amb-${TAG}`]);
    assert.equal(exc.length, 1, 'a Wave 8H reconciliation exception was raised (reused, not duplicated)');
    await assert.rejects(() => outboxService.retry(id), { code: 'OUTBOX_AMBIGUOUS' });
    await query('DELETE FROM reconciliation_events WHERE exception_id = ?', [exc[0].id]);
    await query('DELETE FROM reconciliation_exceptions WHERE id = ?', [exc[0].id]);
  });

  await run('outbox_non_retryable_dead', async () => {
    _resetOutboxHandlers();
    registerOutboxHandler(`vpo.bad.${TAG}`, async () => { throw Object.assign(new Error('nope'), { code: 'PROVIDER_VALIDATION_FAILED' }); });
    const id = await withTransaction((tx) => enqueue(tx, { brandId: BRAND_ID, eventType: `vpo.bad.${TAG}`, payload: {} }));
    await processDue({ workerId: `w-${TAG}`, batch: 50 });
    assert.equal((await R.outboxById(id)).status, 'DEAD');
  });
  _resetOutboxHandlers();

  // ---- 8. normalized errors + correlation --------------------
  await run('normalized_error_vocabulary', async () => {
    assert.equal(normalizeErrorCode({ code: 'RATE_LIMITED' }), NORMALIZED_ERROR.PROVIDER_RATE_LIMITED);
    assert.equal(normalizeErrorCode({ code: 'PROVIDER_NOT_CONFIGURED' }), NORMALIZED_ERROR.PROVIDER_MISCONFIGURED);
    assert.equal(normalizeErrorCode('PROVIDER_TIMEOUT'), NORMALIZED_ERROR.PROVIDER_TIMEOUT);
    assert.equal(normalizeErrorCode({ code: 'something-weird' }), NORMALIZED_ERROR.PROVIDER_UNAVAILABLE);
  });
  await run('attempts_carry_correlation_id', async () => {
    await clearAttempts(HEALTH_CAP, HEALTH_KEY);
    await insertAttempt(HEALTH_CAP, HEALTH_KEY, 'SUCCESS', null);
    const rows = await R.listAttempts({ capability: HEALTH_CAP, providerKey: HEALTH_KEY, offset: 0, limit: 5 });
    assert.ok(rows[0].correlation_id?.startsWith('vpo-'));
  });

  // ---- 9. secret scan --------------------------------------
  await run('no_secret_in_config_table', async () => {
    const rows = await query('SELECT capability, provider_key, config_json FROM provider_configurations');
    const forbidden = /secret|token|password|api[_-]?key|private[_-]?key|credential|bearer|webhook[_-]?secret/i;
    for (const row of rows) {
      const json = JSON.stringify(row.config_json ?? {});
      for (const key of Object.keys(typeof row.config_json === 'string' ? JSON.parse(row.config_json || '{}') : (row.config_json ?? {}))) {
        assert.ok(!forbidden.test(key), `config key "${key}" on ${row.capability}:${row.provider_key} looks secret`);
      }
      assert.ok(!/https?:\/\//i.test(json), 'no endpoint URL persisted in config');
    }
  });

  // ---- 10. RBAC ------------------------------------------
  await run('rbac_present_and_scoped', async () => {
    assert.ok(roleHasPermission('SUPER_ADMIN', 'providers.manage'));
    assert.ok(roleHasPermission('ADMIN', 'provider.webhooks.replay'));
    assert.ok(roleHasPermission('VIEWER', 'providers.read'));
    assert.ok(!roleHasPermission('VIEWER', 'providers.manage'));
    assert.ok(!roleHasPermission('VIEWER', 'provider.webhooks.replay'));
    assert.ok(!roleHasPermission('SUPPORT', 'providers.read'));
  });

  await run('no_real_provider_calls', async () => {
    assert.equal(networkCalls, 0, `expected 0 network calls, saw ${networkCalls}`);
  });
} catch (err) {
  console.error('verify-platform-ops crashed:', err);
  process.exitCode = 1;
} finally {
  const safe = async (fn) => { try { await fn(); } catch (e) { console.error('  cleanup:', e.message); } };
  await safe(() => query('DELETE FROM provider_webhook_inbox WHERE dedupe_key LIKE ?', [`%${TAG}%`]));
  await safe(() => query('DELETE FROM platform_outbox WHERE event_type LIKE ?', [`vpo.%${TAG}%`]));
  await safe(() => query('DELETE FROM platform_outbox WHERE event_type LIKE ?', [`vpo.%.${TAG}`]));
  await safe(() => query("DELETE FROM reconciliation_events WHERE exception_id IN (SELECT id FROM reconciliation_exceptions WHERE source_domain='provider' AND reference_id LIKE ?)", [`%${TAG}%`]));
  await safe(() => query("DELETE FROM reconciliation_exceptions WHERE source_domain='provider' AND reference_id LIKE ?", [`%${TAG}%`]));
  for (const ck of touchedConfigs) {
    const [cap, key] = ck.split(':');
    await safe(() => query('DELETE FROM provider_configuration_revisions WHERE capability = ? AND provider_key = ?', [cap, key]));
    await safe(() => query('DELETE FROM provider_configurations WHERE capability = ? AND provider_key = ?', [cap, key]));
  }
  await safe(() => clearAttempts(HEALTH_CAP, HEALTH_KEY));
  await safe(() => query('DELETE FROM provider_health_events WHERE capability = ? AND provider_key = ?', [HEALTH_CAP, HEALTH_KEY]));
  await safe(() => query('DELETE FROM provider_health WHERE capability = ? AND provider_key = ?', [HEALTH_CAP, HEALTH_KEY]));
  const alertWhere = "entity_type = 'provider' AND entity_id = ?";
  await safe(() => query(`DELETE FROM staff_notification_reads WHERE notification_id IN (SELECT id FROM staff_notifications WHERE ${alertWhere})`, [`${HEALTH_CAP}:${HEALTH_KEY}`]));
  await safe(() => query(`DELETE FROM staff_notifications WHERE ${alertWhere}`, [`${HEALTH_CAP}:${HEALTH_KEY}`]));

  const residue = {};
  residue.healthAlerts = (await query(`SELECT COUNT(*) n FROM staff_notifications WHERE ${alertWhere}`, [`${HEALTH_CAP}:${HEALTH_KEY}`]))[0].n;
  residue.inbox = (await query('SELECT COUNT(*) n FROM provider_webhook_inbox WHERE dedupe_key LIKE ?', [`%${TAG}%`]))[0].n;
  residue.outbox = (await query('SELECT COUNT(*) n FROM platform_outbox WHERE event_type LIKE ?', [`vpo.%`]))[0].n;
  residue.configs = (await query('SELECT COUNT(*) n FROM provider_configurations WHERE provider_key = ?', [HEALTH_KEY]))[0].n;
  residue.attempts = (await query('SELECT COUNT(*) n FROM provider_attempts WHERE capability = ? AND provider_key = ?', [HEALTH_CAP, HEALTH_KEY]))[0].n;
  const residueTotal = Object.values(residue).reduce((s, n) => s + Number(n), 0);

  console.log('\n──────── WAVE 8I — verify-platform-ops ────────');
  for (const [k, v] of Object.entries(results)) console.log(`${v.startsWith('PASS') || v.startsWith('SKIP') ? 'ok  ' : 'FAIL'}  ${k}  ${v}`);
  console.log(`\nTEST_RESIDUE = ${residueTotal}  ${JSON.stringify(residue)}`);
  console.log(`REAL_PROVIDER_CALLS = ${networkCalls}`);

  const failed = Object.values(results).filter((v) => v.startsWith('FAIL'));
  if (failed.length || residueTotal !== 0 || networkCalls !== 0) process.exitCode = 1;
  console.log(failed.length ? `\n${failed.length} check(s) FAILED` : '\nAll checks PASS');
  await pool.end();
}
