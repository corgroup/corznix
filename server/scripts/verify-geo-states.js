// The address form's state list is reference data, not a frontend array.
//
// It WAS an array in a React file holding 14 of the 36 names, so a customer in
// Assam, Bihar, Odisha or the North-East could not complete an order: the field
// is required and their state was not offered. Nothing downstream constrained
// it — the API takes any non-empty string — so that array was the only rule,
// and it was wrong. This gate exists so the list cannot quietly shrink again.
//
//   npm run verify:geo-states
import assert from 'node:assert/strict';

const { pool, query } = await import('../src/database/connection/pool.js');

const results = {};

// The Republic of India, as of the 2020 merger of Dadra and Nagar Haveli with
// Daman and Diu and the 2019 reorganisation of Jammu and Kashmir.
const EXPECTED_STATES = 28;
const EXPECTED_UNION_TERRITORIES = 8;
// A few that were missing before, and one of each kind that is easy to forget.
const MUST_INCLUDE = [
  'Assam', 'Bihar', 'Odisha', 'Jharkhand', 'Chhattisgarh', 'Goa', 'Sikkim',
  'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Tripura', 'Arunachal Pradesh',
  'Himachal Pradesh', 'Uttarakhand',
  'Ladakh', 'Jammu and Kashmir', 'Puducherry', 'Lakshadweep', 'Chandigarh',
  'Andaman and Nicobar Islands', 'Dadra and Nagar Haveli and Daman and Diu',
];

try {
  const rows = await query('SELECT code, name, kind, is_active FROM geo_states');
  assert.ok(rows.length > 0, 'geo_states is seeded — migration 103 must have run');

  const active = rows.filter((r) => r.is_active);
  const states = active.filter((r) => r.kind === 'STATE');
  const uts = active.filter((r) => r.kind === 'UNION_TERRITORY');

  assert.equal(states.length, EXPECTED_STATES, `India has ${EXPECTED_STATES} states`);
  assert.equal(uts.length, EXPECTED_UNION_TERRITORIES, `India has ${EXPECTED_UNION_TERRITORIES} union territories`);
  results.counts = `${states.length} states + ${uts.length} union territories`;

  const names = new Set(active.map((r) => r.name));
  const missing = MUST_INCLUDE.filter((n) => !names.has(n));
  assert.deepEqual(missing, [], `every region a customer might live in is offered (missing: ${missing.join(', ')})`);
  results.spotChecks = `PASS (${MUST_INCLUDE.length} checked)`;

  // ISO 3166-2:IN, so the stored value means something outside this database.
  const badCodes = active.filter((r) => !/^IN-[A-Z]{2}$/.test(r.code)).map((r) => r.code);
  assert.deepEqual(badCodes, [], 'codes are ISO 3166-2:IN');
  results.codes = 'PASS (ISO 3166-2:IN)';

  const dupes = active.length - new Set(active.map((r) => r.name)).size;
  assert.equal(dupes, 0, 'no duplicate names');
  results.duplicates = 0;

  // The storefront reads the grouped shape; if the split ever stopped covering
  // every row the form would silently drop the remainder.
  assert.equal(states.length + uts.length, active.length, 'every active row falls into one of the two groups');
  results.grouping = 'PASS';

  results.status = 'PASS';
  console.log('\nGEO_STATES_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nGEO_STATES_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
