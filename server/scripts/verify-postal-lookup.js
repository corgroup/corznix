// PIN-code lookup: classification, completeness, reconciliation, failure
// handling. The directory client is injected, so this never reaches the
// network — CI has no key, and a gate that depends on a government API being
// up would fail for reasons that have nothing to do with our code.
//
//   npm run verify:postal-lookup
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const { pool, query } = await import('../src/database/connection/pool.js');
const { PostalService, PIN_FORMAT } = await import('../src/modules/geo/postalService.js');
const { PostalSourceError, fetchPostalRecords } = await import('../src/modules/geo/dataGovClient.js');
const { resolveStateCode, tidyPlaceName, normalizeRecord } = await import('../src/modules/geo/stateNames.js');

const realFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = (...a) => { networkCalls += 1; return realFetch?.(...a); };

const results = {};
// Structurally valid PINs the directory has no record of (confirmed: the
// data.gov.in resource returns total 0 for 999999).
const PINS = ['999999', '999998', '999997', '999995'];
// Sync-history rows this run writes; removed in `finally`.
const QA_RESOURCE = `qa-verify-postal-${randomUUID().slice(0, 8)}`;
const record = (over) => ({ pincode: '999999', officename: 'Qa Office', officetype: 'PO', delivery: 'Delivery', district: 'LUCKNOW', statename: 'UTTAR PRADESH', ...over });
const noLive = () => { throw new Error('live lookup must not be called'); };

try {
  await query(`DELETE FROM postal_offices WHERE pincode IN (${PINS.map(() => '?').join(',')})`, PINS);
  const base = new PostalService({ isConfigured: () => false, fetchRecords: noLive });
  const states = await base.states();

  // 1 — structural invalidity is the only certain "invalid" ------------------
  for (const bad of ['012345', '12345', '1234567', 'abcdef', '', null]) {
    const r = await base.lookup(bad);
    assert.equal(r.status, 'INVALID', `"${bad}" must be INVALID`);
  }
  assert.ok(PIN_FORMAT.test('226001'));
  assert.ok(!PIN_FORMAT.test('026001'), 'there is no postal zone 0');
  results.invalidFormat = 'PASS';

  // 2 — state names reconcile to canonical geo_states rows -------------------
  assert.equal(resolveStateCode('UTTAR PRADESH', states), 'IN-UP');
  assert.equal(resolveStateCode('DELHI', states), 'IN-DL');
  assert.equal(resolveStateCode('THE DADRA AND NAGAR HAVELI AND DAMAN AND DIU', states), 'IN-DH');
  assert.equal(resolveStateCode('Jammu & Kashmir', states), 'IN-JK');
  assert.equal(resolveStateCode('Orissa', states), 'IN-OR');
  assert.equal(resolveStateCode('Atlantis', states), null, 'an unknown name resolves to nothing, not a guess');
  assert.equal(tidyPlaceName('RAE BARELI'), 'Rae Bareli');
  assert.equal(tidyPlaceName('NA'), null, 'a placeholder is never offered as a place');
  assert.equal(normalizeRecord({ pincode: '523261', statename: 'NA', district: 'NA' }).stateName, null, 'a placeholder state is an absence, not a name to map');
  assert.equal(normalizeRecord({ pincode: '226001', statename: 'UTTAR PRADESH' }).stateName, 'UTTAR PRADESH');
  assert.equal(normalizeRecord({ pincode: 226001, districtname: 'KANPUR NAGAR', deliverystatus: 'Delivery' }).district, 'Kanpur Nagar', 'older field names are understood');
  assert.equal(normalizeRecord({ pincode: '226001', latitude: '999', longitude: 'NA' }).latitude, null, 'an out-of-range coordinate is dropped, not inserted');
  results.stateReconciliation = 'PASS';

  const seed = (recs) => base.upsertOffices(
    recs.map(normalizeRecord).map((r) => ({ ...r, stateCode: resolveStateCode(r.stateName, states) })),
    'DIRECTORY');

  // 3 — a complete directory answer ------------------------------------------
  await seed([record({ officename: 'Qa Alpha SO' }), record({ officename: 'Qa Beta BO', delivery: 'Non Delivery' })]);
  const full = await base.lookup('999999');
  assert.equal(full.status, 'FOUND');
  assert.deepEqual(full.state, { code: 'IN-UP', name: 'Uttar Pradesh' }, 'state is the canonical row, not India Post spelling');
  assert.equal(full.district, 'Lucknow');
  assert.equal(full.complete, true);
  assert.deepEqual(full.localities, ['Qa Alpha SO', 'Qa Beta BO'], 'delivering office listed first');
  results.directoryFound = 'PASS';

  // 4 — incomplete: no district. Found, but not presented as complete ---------
  await seed([record({ pincode: '999998', officename: 'Qa Gamma SO', district: 'NA' })]);
  const partial = await base.lookup('999998');
  assert.equal(partial.status, 'FOUND');
  assert.equal(partial.district, null, 'a missing district is null, never an empty guess');
  assert.equal(partial.state.code, 'IN-UP', 'what the source does know is still returned');
  assert.equal(partial.complete, false);
  results.incompleteRecord = 'PASS';

  // 5 — a PIN on a district border offers both, chooses neither --------------
  await seed([
    record({ pincode: '999997', officename: 'Qa East SO', district: 'Unnao' }),
    record({ pincode: '999997', officename: 'Qa West SO', district: 'LUCKNOW' }),
  ]);
  const border = await base.lookup('999997');
  assert.equal(border.district, null);
  assert.deepEqual(border.districts, ['Lucknow', 'Unnao']);
  assert.equal(border.complete, false);
  results.multiDistrictPin = 'PASS';

  // 6 — casing variants of one district list once ----------------------------
  const districts = await base.districtsForState('IN-UP');
  assert.equal(districts.status, 'AVAILABLE');
  assert.equal(districts.districts.filter((d) => d === 'Lucknow').length, 1, '"LUCKNOW" and "Lucknow" are one district');
  assert.equal((await base.districtsForState('IN-ZZ')).status, 'UNKNOWN_STATE');
  results.districtsByState = 'PASS';

  // 7 — no key. An absent PIN is NOT_FOUND only once a FULL sync of this
  //     resource has succeeded; rows from single-PIN, trial or failed runs
  //     prove nothing about other PINs. Scoped to a throwaway resource id so
  //     real sync history in the database cannot change the outcome.
  const scoped = new PostalService({ isConfigured: () => false, fetchRecords: noLive, resourceId: QA_RESOURCE });
  const addSync = (scope, status) => query(
    'INSERT INTO postal_directory_syncs (id, resource_id, scope, status) VALUES (?, ?, ?, ?)', [randomUUID(), QA_RESOURCE, scope, status]);
  const unsynced = await scoped.lookup('999996');
  assert.deepEqual([unsynced.status, unsynced.reason], ['UNAVAILABLE', 'NOT_CONFIGURED'], 'rows alone (seeded above) do not make the directory complete');
  await addSync('PINCODE', 'SUCCEEDED');
  await addSync('PARTIAL', 'SUCCEEDED');
  await addSync('FULL', 'FAILED');
  await addSync('FULL', 'RUNNING');
  const partialSync = await scoped.lookup('999996');
  assert.deepEqual([partialSync.status, partialSync.reason], ['UNAVAILABLE', 'NOT_CONFIGURED'], 'single-PIN, partial, failed or unfinished syncs leave an absent PIN unverifiable');
  assert.equal((await scoped.lookup('999999')).status, 'FOUND', 'a PIN that is stored is found whatever the sync history');
  await addSync('FULL', 'SUCCEEDED');
  const absent = await scoped.lookup('999996');
  assert.equal(absent.status, 'NOT_FOUND', 'after a complete sync a missing record is "could not verify", not proof of invalidity');
  const other = new PostalService({ isConfigured: () => false, fetchRecords: noLive, resourceId: `${QA_RESOURCE}-other` });
  assert.equal((await other.lookup('999996')).status, 'UNAVAILABLE', 'a full sync of a different resource does not count');
  results.notFoundVersusUnavailable = 'PASS';

  // 8 — live lookup: empty, each failure kind, success-then-cached ------------
  const live = (fetchRecords) => new PostalService({ isConfigured: () => true, fetchRecords });
  assert.equal((await live(async () => ({ records: [], total: 0 })).lookup('999996')).status, 'NOT_FOUND');
  for (const kind of ['TIMEOUT', 'NETWORK', 'HTTP', 'INVALID_RESPONSE']) {
    const r = await live(async () => { throw new PostalSourceError(kind, kind); }).lookup('999996');
    assert.deepEqual([r.status, r.reason], ['UNAVAILABLE', kind], `${kind} is UNAVAILABLE, not NOT_FOUND`);
  }
  let calls = 0;
  const fetched = await live(async () => {
    calls += 1;
    return { records: [record({ pincode: '999995', officename: 'Qa Live SO' })], total: 1 };
  }).lookup('999995');
  assert.equal(fetched.status, 'FOUND');
  assert.equal(fetched.source, 'LIVE');
  const cached = await live(noLive).lookup('999995');
  assert.equal(cached.status, 'FOUND', 'a live answer is cached for the next lookup');
  assert.equal(calls, 1);
  const truncated = await live(async () => ({ records: [record({ pincode: '999995', officename: 'Qa Live SO' })], total: 7 })).lookupLive('999995');
  assert.equal(truncated.complete, false, 'fewer offices than the directory reports is marked incomplete');
  results.liveLookup = 'PASS';

  // 9 — the client classifies every failure kind ----------------------------
  const client = (impl) => fetchPostalRecords({ apiKey: 'test', resourceId: 'r', timeoutMs: 50, fetchImpl: impl });
  const kindOf = async (promise) => { try { await promise; return 'OK'; } catch (e) { return e.kind; } };
  assert.equal(await kindOf(fetchPostalRecords({ apiKey: '', fetchImpl: noLive })), 'NOT_CONFIGURED');
  assert.equal(await kindOf(client(async () => ({ ok: false, status: 503, text: async () => '' }))), 'HTTP');
  assert.equal(await kindOf(client(async () => ({ ok: true, text: async () => '<html>' }))), 'INVALID_RESPONSE');
  assert.equal(await kindOf(client(async () => ({ ok: true, text: async () => '{"status":"ok"}' }))), 'INVALID_RESPONSE');
  assert.equal(await kindOf(client(async () => ({ ok: true, text: async () => '{"status":"error","message":"Invalid key","records":[]}' }))), 'HTTP');
  assert.equal(await kindOf(client(async () => { throw new TypeError('fetch failed'); })), 'NETWORK');
  assert.equal(await kindOf(client((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }))), 'TIMEOUT');
  const ok = await client(async () => ({ ok: true, text: async () => '{"status":"ok","total":1,"records":[{"pincode":"226001"}]}' }));
  assert.equal(ok.records.length, 1);
  // 429 is throttling, not an outage or a bad key — and Retry-After is read.
  const throttled = await client(async () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '7' }), text: async () => '' })).catch((e) => e);
  assert.deepEqual([throttled.kind, throttled.status, throttled.retryAfterMs], ['RATE_LIMITED', 429, 7000]);
  const liveThrottled = await live(async () => { throw throttled; }).lookup('999996');
  assert.deepEqual([liveThrottled.status, liveThrottled.reason], ['UNAVAILABLE', 'RATE_LIMITED'], 'a throttled customer lookup is unavailable, never not-found');
  results.clientClassification = 'PASS';

  // 10 — bulk fetches ride out throttling; permanent failures do not retry ----
  const { fetchPostalRecordsWithRetry, isTransientPostalError } = await import('../src/modules/geo/dataGovClient.js');
  const replies = (...steps) => { let i = 0; return async () => steps[Math.min(i++, steps.length - 1)](); };
  const okReply = () => ({ ok: true, status: 200, text: async () => '{"status":"ok","total":1,"records":[{"pincode":"226001"}]}' });
  const status = (code, headers = {}) => () => ({ ok: false, status: code, headers: new Headers(headers), text: async () => '' });
  const retried = async (impl, attempts = 4) => {
    const waits = [];
    const result = await fetchPostalRecordsWithRetry({
      apiKey: 'test', resourceId: 'r', timeoutMs: 50, fetchImpl: impl, attempts, baseDelayMs: 1000, maxDelayMs: 60000,
      sleep: async (ms) => { waits.push(ms); },
    }).catch((e) => e);
    return { result, waits };
  };
  const recovered = await retried(replies(status(429), status(429, { 'retry-after': '3' }), status(503), okReply));
  assert.equal(recovered.result.records?.length, 1, 'throttling and a 5xx are ridden out');
  assert.deepEqual(recovered.waits, [1000, 3000, 4000], 'exponential backoff, overridden by Retry-After');
  const exhausted = await retried(replies(status(429)), 3);
  assert.deepEqual([exhausted.result.kind, exhausted.waits.length], ['RATE_LIMITED', 2], 'gives up after the attempt limit and says why');
  const forbidden = await retried(replies(status(403), okReply));
  assert.deepEqual([forbidden.result.kind, forbidden.result.status, forbidden.waits.length], ['HTTP', 403, 0], 'a rejected key is not retried');
  const capped = await retried(replies(status(429, { 'retry-after': '99999' }), okReply));
  assert.deepEqual(capped.waits, [60000], 'a huge Retry-After is capped');
  assert.equal(isTransientPostalError(new PostalSourceError('INVALID_RESPONSE', 'x')), false);
  results.bulkRetry = 'PASS';

  assert.equal(networkCalls, 0, 'no network calls');
  results.realNetworkCalls = 0;
  results.status = 'PASS';
  console.log('\nPOSTAL_LOOKUP_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  console.error('\nPOSTAL_LOOKUP_VERIFICATION = FAIL');
  console.error(error);
  process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
  await query(`DELETE FROM postal_offices WHERE pincode IN (${PINS.map(() => '?').join(',')})`, PINS)
    .catch((e) => console.error('  cleanup:', e.message));
  await query('DELETE FROM postal_directory_syncs WHERE resource_id LIKE ?', [`${QA_RESOURCE}%`])
    .catch((e) => console.error('  cleanup:', e.message));
  await pool.end();
}
