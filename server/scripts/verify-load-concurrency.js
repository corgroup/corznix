// Wave 8J-6 — load / concurrency / failure behaviour of the operational
// plane. Correctness under contention, not vanity RPS. All in-process, no
// real provider calls. Self-cleaning. Latency numbers are LOCAL_BASELINE_ONLY.
//
//   npm run verify:load-concurrency
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.PLATFORM_OUTBOX_WORKER_ENABLED = 'false';
process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';
process.env.COMMUNICATION_WORKER_ENABLED = 'false';

const realFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(url)) networkCalls += 1;
  return realFetch(input, init);
};

const { pool, query } = await import('../src/database/connection/pool.js');
const { withTransaction } = await import('../src/database/connection/transaction.js');
const { createApp } = await import('../src/app.js');
const { platformRepository: R } = await import('../src/modules/platform/repository.js');
const {
  enqueue, processDue, registerOutboxHandler, _resetOutboxHandlers,
} = await import('../src/modules/platform/outboxService.js');
const {
  webhookInboxService, registerWebhookVerifier, registerWebhookParser, registerWebhookApplier, _resetWebhookRegistries,
} = await import('../src/modules/platform/webhookInboxService.js');

const results = {};
const baselines = {};
// The outbox refuses an event with no company: an ambiguous provider
// outcome on one has nowhere to be filed as a reconciliation exception.
const [defaultBrand] = await query('SELECT id FROM brands WHERE is_default = 1 LIMIT 1');
if (!defaultBrand) throw new Error('no default brand — run the migrations and seed first');
const BRAND_ID = defaultBrand.id;

const TAG = randomUUID().slice(0, 8);
const run = async (name, fn) => {
  try { await fn(); results[name] = 'PASS'; console.log(`  PASS  ${name}`); }
  catch (e) { results[name] = `FAIL: ${e.message}`; console.error(`  FAIL  ${name}: ${e.message}`); }
};

try {
  // ---- webhook burst: unique + duplicate + out-of-order --------
  await run('webhook_burst_idempotent', async () => {
    _resetWebhookRegistries();
    const applied = new Set();
    let applyCount = 0;
    registerWebhookVerifier('payments', 'MOCK_PAYMENT', () => true);
    registerWebhookParser('payments', 'MOCK_PAYMENT', (p) => ({ providerEventId: p.id, normalizedEventType: p.seq, resourceType: 'payment', resourceId: p.ref }));
    registerWebhookApplier('payments', async (e) => {
      applyCount += 1;
      // out-of-order guard: only advance if newer
      const cur = applied.has(e.resourceId) ? 1 : 0;
      const incoming = Number(e.normalizedEventType);
      if (incoming < cur) return 'IGNORED';
      applied.add(e.resourceId);
      return 'APPLIED';
    });

    const events = [];
    for (let i = 0; i < 40; i += 1) {
      const id = `lb-${TAG}-${i}`;
      events.push({ id, seq: '1', ref: `ord-${i % 10}` });
      if (i % 3 === 0) events.push({ id, seq: '1', ref: `ord-${i % 10}` }); // duplicate
    }
    events.push({ id: `lb-${TAG}-x`, seq: '0', ref: 'ord-0' }); // stale/out-of-order

    const outcomes = await Promise.all(events.map((ev) =>
      webhookInboxService.ingest({ capability: 'payments', providerKey: 'MOCK_PAYMENT', rawBody: JSON.stringify(ev), headers: {} })));

    const uniqueEvents = new Set(events.map((e) => e.id)).size; // 41
    const dupes = outcomes.filter((o) => o.status === 'DUPLICATE').length;
    const rows = await query('SELECT COUNT(*) n FROM provider_webhook_inbox WHERE dedupe_key LIKE ?', [`%${TAG}%`]);
    assert.equal(Number(rows[0].n), uniqueEvents, 'exactly one inbox row per unique provider event id');
    assert.equal(dupes, events.length - uniqueEvents, 'every re-delivery deduped');
    assert.equal(applyCount, uniqueEvents, 'applier invoked once per unique event, never for a duplicate');
    _resetWebhookRegistries();
  });

  // ---- outbox burst: bounded claims, single processing --------
  await run('outbox_burst_single_processing', async () => {
    _resetOutboxHandlers();
    const processed = new Map();
    registerOutboxHandler(`lb.job.${TAG}`, async (_p, ctx) => {
      processed.set(ctx.aggregateId, (processed.get(ctx.aggregateId) || 0) + 1);
    });
    const N = 50;
    for (let i = 0; i < N; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await withTransaction((tx) => enqueue(tx, { brandId: BRAND_ID, eventType: `lb.job.${TAG}`, aggregateType: 'job', aggregateId: `j-${TAG}-${i}`, payload: {} }));
    }
    // 4 workers drain concurrently.
    //
    // A worker must NOT stop at its first empty batch. With four of them
    // competing, an empty poll usually means the other three are holding the
    // claims, not that the queue is drained — so on a busy machine all four
    // could bow out early and leave jobs behind. That failed this check with
    // "40 !== 50" for a reason that has nothing to do with what it asserts:
    // that concurrent workers process each job exactly once. Stop on an empty
    // poll only once nothing is actually left.
    const outstanding = async () => Number((await query(
      "SELECT COUNT(*) n FROM platform_outbox WHERE event_type = ? AND status <> 'PROCESSED'", [`lb.job.${TAG}`]))[0].n);
    await Promise.all(Array.from({ length: 4 }, (_, w) => (async () => {
      for (let k = 0; k < 40; k += 1) {
        // eslint-disable-next-line no-await-in-loop
        const r = await processDue({ workerId: `lw-${TAG}-${w}`, batch: 7, reclaim: false });
        // eslint-disable-next-line no-await-in-loop
        if (r.length === 0 && await outstanding() === 0) break;
      }
    })()));
    const done = await query("SELECT COUNT(*) n FROM platform_outbox WHERE event_type = ? AND status = 'PROCESSED'", [`lb.job.${TAG}`]);
    assert.equal(Number(done[0].n), N, 'every job processed');
    assert.equal(processed.size, N, 'every aggregate handled');
    assert.ok([...processed.values()].every((c) => c === 1), 'each job processed exactly once under 4 concurrent workers');
  });

  // ---- provider timeout load: no retry storm -----------------
  await run('provider_timeout_load_no_storm', async () => {
    _resetOutboxHandlers();
    let calls = 0;
    registerOutboxHandler(`lb.to.${TAG}`, async () => { calls += 1; throw Object.assign(new Error('t'), { code: 'PROVIDER_TIMEOUT' }); });
    const N = 20;
    for (let i = 0; i < N; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await withTransaction((tx) => enqueue(tx, { brandId: BRAND_ID, eventType: `lb.to.${TAG}`, aggregateType: 'payment', aggregateId: `to-${TAG}-${i}`, payload: { capability: 'payments', providerKey: 'MOCK_PAYMENT' } }));
    }
    for (let k = 0; k < 10; k += 1) {
      // eslint-disable-next-line no-await-in-loop
      await processDue({ workerId: `lw-${TAG}`, batch: 50 });
    }
    assert.equal(calls, N, 'each ambiguous job attempted exactly once, never retried');
    const stuck = await query("SELECT COUNT(*) n FROM platform_outbox WHERE event_type = ? AND status = 'RECONCILIATION_REQUIRED'", [`lb.to.${TAG}`]);
    assert.equal(Number(stuck[0].n), N, 'all routed to reconciliation, none blind-retried');
    await query("DELETE FROM reconciliation_events WHERE exception_id IN (SELECT id FROM reconciliation_exceptions WHERE dedupe_key LIKE ?)", [`%${TAG}%`]);
    await query('DELETE FROM reconciliation_exceptions WHERE dedupe_key LIKE ?', [`%${TAG}%`]);
  });

  // ---- latency baseline (LOCAL ONLY) ------------------------
  await run('latency_baseline_captured', async () => {
    const app = createApp();
    const server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
    const port = server.address().port;
    const bench = async (path, n) => {
      const ms = [];
      for (let i = 0; i < n; i += 1) {
        const t = process.hrtime.bigint();
        // eslint-disable-next-line no-await-in-loop
        await realFetch(`http://127.0.0.1:${port}${path}`).then((r) => r.text());
        ms.push(Number(process.hrtime.bigint() - t) / 1e6);
      }
      ms.sort((a, b) => a - b);
      return { p50: Math.round(ms[Math.floor(n * 0.5)]), p95: Math.round(ms[Math.floor(n * 0.95)]) };
    };
    try {
      baselines['/api/v1/health/live'] = await bench('/api/v1/health/live', 100);
      baselines['/api/v1/health/ready'] = await bench('/api/v1/health/ready', 60);
      baselines['/api/v1/products'] = await bench('/api/v1/products', 40);
    } finally { await new Promise((r) => server.close(r)); }
    assert.ok(baselines['/api/v1/health/live'].p95 < 250, 'liveness p95 sane locally');
  });

  await run('no_real_provider_calls', async () => assert.equal(networkCalls, 0));
} catch (err) {
  console.error('verify-load-concurrency crashed:', err);
  process.exitCode = 1;
} finally {
  const safe = async (fn) => { try { await fn(); } catch (e) { console.error('  cleanup:', e.message); } };
  await safe(() => query('DELETE FROM platform_outbox WHERE event_type LIKE ?', [`lb.%.${TAG}`]));
  await safe(() => query('DELETE FROM provider_webhook_inbox WHERE dedupe_key LIKE ?', [`%${TAG}%`]));
  await safe(() => query("DELETE FROM reconciliation_events WHERE exception_id IN (SELECT id FROM reconciliation_exceptions WHERE dedupe_key LIKE ?)", [`%${TAG}%`]));
  await safe(() => query('DELETE FROM reconciliation_exceptions WHERE dedupe_key LIKE ?', [`%${TAG}%`]));

  // Scoped to THIS run's tag, like the cleanup above and the other two counts.
  // Unscoped (`event_type LIKE 'lb.%'`) it counted every past run's rows too,
  // so a single interrupted run left orphans that failed this gate on every
  // subsequent run, forever — observed at 70 rows under one dead tag. What the
  // check is for is "did this run clean up after itself", and that is what it
  // now measures.
  const residue = Number((await query(
    "SELECT (SELECT COUNT(*) FROM platform_outbox WHERE event_type LIKE ?) + (SELECT COUNT(*) FROM provider_webhook_inbox WHERE dedupe_key LIKE ?) + (SELECT COUNT(*) FROM reconciliation_exceptions WHERE dedupe_key LIKE ?) n",
    [`lb.%.${TAG}`, `%${TAG}%`, `%${TAG}%`]))[0].n);

  console.log('\n──── Wave 8J load / concurrency ────');
  console.log(JSON.stringify(results, null, 1));
  console.log('LOCAL_BASELINE_ONLY latency:', JSON.stringify(baselines));
  console.log(`TEST_RESIDUE = ${residue}`);
  console.log(`REAL_PROVIDER_CALLS = ${networkCalls}`);
  const failed = Object.values(results).filter((v) => v.startsWith('FAIL'));
  if (failed.length || residue !== 0) process.exitCode = 1;
  console.log(failed.length ? `\n${failed.length} FAILED` : '\nAll checks PASS');
  await pool.end();
}
