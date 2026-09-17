// Refresh the local India Post PIN directory from the Department of Posts
// resource on the Government Open Data platform.
//
//   npm run postal:sync                      full directory (~166 pages, a few minutes)
//   npm run postal:sync -- --pincode=226001  one PIN
//   npm run postal:sync -- --max-pages=3     a bounded trial run
//   --delay-ms=1000                          pause between pages (default 1000)
//
// Needs DATA_GOV_IN_API_KEY (register free at data.gov.in). Safe to re-run:
// rows are upserted on (pincode, office_name). The directory is published
// monthly, so a monthly run keeps it current.
//
// The platform throttles bursts with HTTP 429. Pages are paced, and a
// throttled, timed-out or 5xx page waits and retries (Retry-After, else
// exponential backoff) instead of failing the whole run.
//
// Each run records its scope. Only a FULL run that reached the last record
// lets a lookup call an absent PIN "not found"; PINCODE and PARTIAL runs add
// rows without claiming the table is complete. There is deliberately no
// "resume from offset": a run that did not itself fetch every record cannot
// vouch for the table being complete. A failed run is simply re-run.
import { randomUUID } from 'node:crypto';

const { env } = await import('../src/config/index.js');
const { pool, query } = await import('../src/database/connection/pool.js');
const { fetchPostalRecordsWithRetry } = await import('../src/modules/geo/dataGovClient.js');
const { normalizeRecord, resolveStateCode } = await import('../src/modules/geo/stateNames.js');
const { PostalService } = await import('../src/modules/geo/postalService.js');

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const pincode = arg('pincode');
const maxPages = arg('max-pages') ? Number(arg('max-pages')) : Infinity;
const pageSize = arg('page-size') ? Number(arg('page-size')) : 1000;
const delayMs = arg('delay-ms') ? Number(arg('delay-ms')) : 1000;

if (!env.DATA_GOV_IN_API_KEY) {
  console.error('POSTAL_SYNC = FAIL\n  DATA_GOV_IN_API_KEY is not set. Generate one at data.gov.in and set it in the environment.');
  await pool.end();
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const service = new PostalService();
const states = await service.states();
const runId = randomUUID();
// Recorded as PARTIAL until it proves it reached the end.
await query('INSERT INTO postal_directory_syncs (id, resource_id, scope, status) VALUES (?, ?, ?, ?)',
  [runId, env.POSTAL_DIRECTORY_RESOURCE_ID, pincode ? 'PINCODE' : 'PARTIAL', 'RUNNING']);

let fetched = 0;
let upserted = 0;
let retries = 0;
// Records the source publishes with no state at all ("NA"). Kept, because the
// office and PIN are still real; counted apart from `unresolved`, which is
// names we could not map and would need a code change.
let withoutState = 0;
let scope = pincode ? 'PINCODE' : 'PARTIAL';
const unresolved = new Map();
try {
  let offset = 0;
  let total = null;
  for (let page = 0; page < maxPages; page += 1) {
    if (page > 0 && delayMs > 0) await sleep(delayMs);
    const reply = await fetchPostalRecordsWithRetry({
      filters: pincode ? { pincode } : {},
      offset,
      limit: pageSize,
      timeoutMs: 30000,
      onRetry: ({ attempt, delayMs: wait, error }) => {
        retries += 1;
        process.stdout.write(`  page ${page + 1}: ${error.kind}${error.status ? ` ${error.status}` : ''} — retry ${attempt} in ${Math.round(wait / 1000)}s\n`);
      },
    });
    total = reply.total;
    if (reply.records.length === 0) break;
    // Advance by what actually arrived, not by the size asked for: the
    // platform does not publish a maximum page size and may return fewer.
    offset += reply.records.length;
    fetched += reply.records.length;
    const offices = reply.records.map(normalizeRecord).map((r) => {
      const stateCode = resolveStateCode(r.stateName, states);
      if (!r.stateName) withoutState += 1;
      else if (!stateCode) unresolved.set(r.stateName, (unresolved.get(r.stateName) || 0) + 1);
      return { ...r, stateCode };
    });
    upserted += await service.upsertOffices(offices, 'DIRECTORY');
    process.stdout.write(`  page ${page + 1}: ${fetched}${total ? `/${total}` : ''} fetched, ${upserted} upserted\n`);
    if (total !== null && offset >= total) break;
  }
  // FULL only when every record the source reported has arrived. A run cut
  // short by --max-pages, or a source that stopped paging early, stays PARTIAL.
  if (!pincode && total !== null && total > 0 && fetched >= total) scope = 'FULL';
  const unresolvedList = Object.fromEntries(unresolved);
  await query(
    'UPDATE postal_directory_syncs SET scope = ?, status = ?, records_fetched = ?, records_upserted = ?, unresolved_states = ?, finished_at = NOW(3) WHERE id = ?',
    [scope, 'SUCCEEDED', fetched, upserted, JSON.stringify(unresolvedList), runId]);
  console.log('\nPOSTAL_SYNC = PASS');
  console.log(JSON.stringify({ runId, scope, fetched, total, upserted, retries, withoutState, unresolvedStates: unresolvedList }, null, 2));
  if (withoutState) {
    console.log(`  INFO: ${withoutState} records carry no state in the source; lookups for those offices fill no state, never a guess.`);
  }
  if (!pincode && scope !== 'FULL') {
    console.warn('  NOTE: this run did not reach the end of the directory, so lookups without a key will still report absent PINs as unverifiable.');
  }
  // Unresolved state names are not a crash, but they are not fine either:
  // those rows cannot be validated against a state until the name is mapped.
  if (unresolved.size) console.warn('  WARNING: some state names did not resolve to geo_states — see unresolvedStates.');
} catch (error) {
  const reason = `${error?.kind || 'ERROR'}: ${error?.message || error}`;
  await query(
    'UPDATE postal_directory_syncs SET status = ?, records_fetched = ?, records_upserted = ?, error_message = ?, finished_at = NOW(3) WHERE id = ?',
    ['FAILED', fetched, upserted, reason.slice(0, 500), runId]).catch(() => {});
  console.error('\nPOSTAL_SYNC = FAIL');
  console.error(`  ${reason} (after ${fetched} records, ${retries} retries)`);
  console.error('  Rows already fetched are kept. Re-run the sync; it upserts, so nothing is duplicated.');
  process.exitCode = 1;
} finally {
  await pool.end();
}
