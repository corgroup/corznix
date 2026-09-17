// Phase 2 (2026-09-03) — destination-aware warehouse selection.
//
// The customer's delivery PIN decides the fulfilling warehouse:
//   real carrier TAT (fewest days) → else PIN-code proximity → else priority.
// Deterministic backend rule, no mock, no frontend calculation.
import assert from 'node:assert/strict';
import { sharedPinPrefix, rankWarehousesForDestination } from '../src/modules/warehouses/warehouseSelection.js';

const results = {};
const check = (name, fn) => {
  try { fn(); results[name] = 'PASS'; }
  catch (e) { results[name] = `FAIL ${e.message}`; }
  console.log(`  ${results[name].startsWith('FAIL') ? 'FAIL' : 'PASS'}  ${name}`);
};

const A = { id: 'A', postal_code: '110001', priority: 1 }; // Delhi
const B = { id: 'B', postal_code: '201301', priority: 2 }; // Noida
const C = { id: 'C', postal_code: '226001', priority: 3 }; // Lucknow
const all = [A, B, C];

check('shared_prefix', () => {
  assert.equal(sharedPinPrefix('201301', '201301'), 6);
  assert.equal(sharedPinPrefix('201305', '201301'), 5);
  assert.equal(sharedPinPrefix('226001', '201301'), 1);
  assert.equal(sharedPinPrefix('110001', '201301'), 0);
});

check('exact_pin_match_wins', () => {
  const { ranked, reason } = rankWarehousesForDestination(all, '201301');
  assert.equal(ranked[0].id, 'B'); // the example: dest 201301 -> Warehouse B
  assert.equal(reason, 'PIN_PROXIMITY');
});

check('nearest_by_prefix', () => {
  const { ranked } = rankWarehousesForDestination(all, '201455'); // shares 2013.. with B
  assert.equal(ranked[0].id, 'B');
});

check('same_region_only', () => {
  const { ranked, reason } = rankWarehousesForDestination(all, '281001'); // Mathura: shares only '2'
  assert.equal(reason, 'PIN_PROXIMITY');
  assert.ok(['B', 'C'].includes(ranked[0].id)); // both start '2', B has better priority
  assert.equal(ranked[0].id, 'B');
});

check('no_shared_prefix_falls_back_to_priority', () => {
  const { ranked, reason } = rankWarehousesForDestination(all, '682001'); // Kochi: no warehouse starts '6'
  assert.equal(reason, 'PRIORITY');
  assert.equal(ranked[0].id, 'A'); // priority order
});

check('real_tat_beats_proximity', () => {
  const tat = new Map([['A', 5], ['B', 2], ['C', 8]]);
  const { ranked, reason } = rankWarehousesForDestination(all, '110001', tat);
  assert.equal(reason, 'TAT');
  assert.equal(ranked[0].id, 'B'); // fewest days, even though A is an exact PIN match
});

check('no_destination_is_priority_order', () => {
  const { ranked, reason } = rankWarehousesForDestination(all, null);
  assert.deepEqual(ranked.map((w) => w.id), ['A', 'B', 'C']);
  assert.equal(reason, 'PRIORITY');
});

check('single_warehouse_unchanged', () => {
  const { ranked, reason } = rankWarehousesForDestination([B], '110001');
  assert.deepEqual(ranked, [B]);
  assert.equal(reason, 'PRIORITY');
});

check('deterministic', () => {
  const r1 = rankWarehousesForDestination(all, '201455').ranked.map((w) => w.id);
  const r2 = rankWarehousesForDestination([...all].reverse(), '201455').ranked.map((w) => w.id);
  assert.deepEqual(r1, r2); // input order must not matter
});

console.log('\n──── Phase 2 — warehouse selection ────');
const failed = Object.entries(results).filter(([, v]) => String(v).startsWith('FAIL'));
console.log(`\nWAREHOUSE_SELECTION = ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length})`}`);
process.exitCode = failed.length === 0 ? 0 : 1;
