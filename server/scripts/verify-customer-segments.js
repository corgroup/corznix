// Wave 8G-5 — customer segments.
//
// Whitelisted structured rule definitions only — no arbitrary SQL/JS from the
// CMS (ARBITRARY_SEGMENT_SQL = DISABLED). Backend compiles a validated
// definition into a fully parameterized query. Editing a rule mints a new
// immutable revision; anything that pinned a revision keeps evaluating that
// exact rule (segment-edit vs audience-resolution race). Marketing audience =
// segment ∩ effective consent ∩ not suppressed. Preview is bounded + masked.
// No provider / network calls.
//
//   npm run verify:customer-segments
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';

const { pool, query } = await import('../src/database/connection/pool.js');
const { roleHasPermission } = await import('../src/modules/staff/permissions.js');
const { segmentService } = await import('../src/modules/segments/service.js');
const { compile, validateDefinition } = await import('../src/modules/segments/ruleCompiler.js');
const { consentService } = await import('../src/modules/consent/service.js');

const realFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = (...a) => { networkCalls += 1; return realFetch?.(...a); };

const results = {};
const tag = randomUUID().slice(0, 8);
const SA = `SEG-${tag}-A`;
const SB = `SEG-${tag}-B`;
const created = { customers: [], staff: [], segments: [], reservations: [] };
const emailOf = (cid) => `seg-${cid.slice(0, 8)}@x.test`;

async function customer({ name, state, createdAt }) {
  const id = randomUUID();
  created.customers.push(id);
  await query(
    "INSERT INTO customers (id, brand_id,first_name,last_name,status,profile_completed_at,created_at) VALUES (?, (SELECT id FROM brands WHERE slug='corcotton'),?,?,'ACTIVE',NOW(3),?)",
    [id, name, 'Tester', createdAt]);
  await query(
    `INSERT INTO addresses (id,customer_id,type,first_name,last_name,phone,address_line1,city,state,postal_code,country,is_default)
     VALUES (?,?,'SHIPPING','A','B','9999999999','1 Rd','Lucknow',?,'226001','IN',1)`,
    [randomUUID(), id, state]);
  return id;
}
async function staff(role = 'ADMIN') {
  const id = randomUUID();
  created.staff.push(id);
  await query("INSERT INTO staff_users (id,email,email_normalized,password_hash,first_name,last_name,role,status) VALUES (?,?,?,?,?,?,?,'ACTIVE')",
    [id, `segs-${id.slice(0, 8)}@x.test`, `segs-${id.slice(0, 8)}@x.test`, 'scrypt$1$1$1$x$x', 'S', role, role]);
  return id;
}
async function reservationFor(customerId) {
  const rid = randomUUID();
  created.reservations.push(rid);
  await query(`INSERT INTO inventory_reservations (id, brand_id, customer_id,idempotency_key,request_fingerprint,status,expires_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'), ?,?,?, 'CONSUMED', DATE_ADD(NOW(3),INTERVAL 1 DAY))`, [rid, customerId, `seg:${randomUUID()}`, '0'.repeat(64)]);
  return rid;
}
async function paidOrders(customerId, n, unitMinor = 50000) {
  for (let i = 0; i < n; i += 1) {
    const rid = await reservationFor(customerId);
    await query(`INSERT INTO orders (id, brand_id,order_number,checkout_id,customer_id,inventory_reservation_id,payment_status,payment_mode,currency,
         subtotal_minor,shipping_minor,total_minor,online_paid_minor,cod_due_minor,shipping_address_snapshot,shipping_snapshot,finalization_source,placed_at)
       VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,NULL,?,?, 'PAID','PREPAID','INR', ?,0,?,?,0,'{}','{}','SEG_TEST',NOW(3))`,
      [randomUUID(), `COR-SEG-${tag}-${customerId.slice(0, 4)}-${i}`, customerId, rid, unitMinor, unitMinor, unitMinor]);
  }
}
const grant = (cid, action = 'GRANTED') => consentService.record({
  contactKey: emailOf(cid), channel: 'EMAIL', purpose: 'MARKETING', action, source: 'STAFF_RECORDED', customerId: cid,
});

async function mkSegment(key, definition) {
  const seg = await segmentService.create({ segmentKey: key, name: key, definition, staffId: created.staff[0] });
  created.segments.push(seg.id);
  return seg;
}

try {
  const s1 = await staff('ADMIN');
  void s1;
  // Cohort — sentinel shipping states keep every count deterministic despite
  // other customers in the DB.
  const C1 = await customer({ name: `C1${tag}`, state: SA, createdAt: '2025-06-15 10:00:00' });
  const C2 = await customer({ name: `C2${tag}`, state: SA, createdAt: '2023-02-01 10:00:00' });
  const C3 = await customer({ name: `C3${tag}`, state: SB, createdAt: '2025-06-15 10:00:00' });
  const C4 = await customer({ name: `C4${tag}`, state: SB, createdAt: '2025-06-15 10:00:00' });

  await paidOrders(C1, 2);           // spend 100000
  await paidOrders(C3, 1);           // spend 50000
  await paidOrders(C4, 3, 50000);    // spend 150000

  await grant(C1);                                   // C1: marketable
  await grant(C3); await grant(C3, 'REVOKED');       // C3: revoked -> suppressed
  await grant(C4);
  await consentService.suppress({ contactKey: emailOf(C4), channel: 'EMAIL', reason: 'MANUAL_COMPLIANCE' }); // C4: suppressed

  // ============ 1. rule validation — valid definition ============
  const segA = await mkSegment(`in-sa-${tag}`, { match: 'ALL', conditions: [{ attribute: 'shipping_state', operator: 'EQ', value: SA }] });
  assert.equal(segA.revision, 1);
  assert.equal(segA.definition.conditions.length, 1);
  results.ruleValidation = 'PASS';

  // ============ 2-3. invalid attribute / operator ============
  await assert.rejects(() => segmentService.preview({ definition: { conditions: [{ attribute: 'evil_column', operator: 'EQ', value: 1 }] } }),
    (e) => e.code === 'SEGMENT_RULE_INVALID');
  await assert.rejects(() => segmentService.preview({ definition: { conditions: [{ attribute: 'order_count', operator: 'LIKE', value: 1 }] } }),
    (e) => e.code === 'SEGMENT_RULE_INVALID');
  await assert.rejects(() => segmentService.preview({ definition: { conditions: [{ attribute: 'created_at', operator: 'IN', value: ['2020-01-01'] }] } }),
    (e) => e.code === 'SEGMENT_RULE_INVALID', 'operator not permitted for attribute');
  await assert.rejects(() => segmentService.preview({ definition: { conditions: [{ attribute: 'order_count', operator: 'EQ', value: 'lots' }] } }),
    (e) => e.code === 'SEGMENT_RULE_INVALID', 'value type enforced');
  results.invalidAttribute = 'REJECTED';
  results.invalidOperator = 'REJECTED';

  // ============ 4. SQL injection denial ============
  const evil = "x'; DROP TABLE customers; --";
  const compiled = compile({ match: 'ALL', conditions: [{ attribute: 'shipping_state', operator: 'EQ', value: evil }] });
  assert.ok(!compiled.where.includes('DROP'), 'value never appears in compiled SQL text');
  assert.ok(compiled.where.includes('?'), 'value is a bound placeholder');
  assert.ok(compiled.params.includes(evil), 'literal is carried as a parameter');
  const evilCount = await segmentService.preview({ definition: { match: 'ALL', conditions: [{ attribute: 'shipping_state', operator: 'EQ', value: evil }] } });
  assert.equal(evilCount.count, 0);
  assert.equal((await query("SELECT COUNT(*) c FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customers'"))[0].c, 1, 'customers table intact');
  results.arbitrarySegmentSql = 'DISABLED';

  // ============ 5. deterministic count ============
  assert.equal((await segmentService.preview({ id: segA.id })).count, 2, 'state EQ SA -> C1,C2');
  const seg2 = await mkSegment(`sa-2plus-${tag}`, { match: 'ALL', conditions: [
    { attribute: 'shipping_state', operator: 'EQ', value: SA },
    { attribute: 'order_count', operator: 'GTE', value: 2 },
  ] });
  assert.equal((await segmentService.preview({ id: seg2.id })).count, 1, 'SA AND >=2 orders -> C1');
  const segSpend = await mkSegment(`spend-${tag}`, { match: 'ALL', conditions: [
    { attribute: 'shipping_state', operator: 'IN', value: [SA, SB] },
    { attribute: 'lifetime_spend_minor', operator: 'GTE', value: 100000 },
  ] });
  assert.equal((await segmentService.preview({ id: segSpend.id })).count, 2, 'spend >= 100000 -> C1 (100k) + C4 (150k)');
  results.deterministicCount = 'PASS';

  // ============ 6. ANY (OR) union ============
  const segAny = await mkSegment(`any-${tag}`, { match: 'ANY', conditions: [
    { attribute: 'shipping_state', operator: 'EQ', value: SA },
    { attribute: 'shipping_state', operator: 'EQ', value: SB },
  ] });
  assert.equal((await segmentService.preview({ id: segAny.id })).count, 4, 'SA OR SB -> whole cohort');
  results.anyMatchUnion = 'PASS';

  // compile smoke for the join-based attributes (no throw, runs)
  validateDefinition({ conditions: [{ attribute: 'has_purchased_category', operator: 'EQ', value: randomUUID() }] });
  validateDefinition({ conditions: [{ attribute: 'has_purchased_collection', operator: 'IN', value: [randomUUID()] }] });

  // ============ 7. versioning ============
  const segV = await mkSegment(`ver-${tag}`, { match: 'ALL', conditions: [{ attribute: 'shipping_state', operator: 'EQ', value: SA }] });
  const rev1Id = segV.currentRevisionId;
  assert.equal((await segmentService.preview({ id: segV.id })).count, 2);
  const afterEdit = await segmentService.addRevision({ id: segV.id, definition: { match: 'ALL', conditions: [
    { attribute: 'shipping_state', operator: 'EQ', value: SA },
    { attribute: 'order_count', operator: 'GTE', value: 2 },
  ] }, staffId: created.staff[0] });
  assert.equal(afterEdit.revision, 2);
  assert.equal(afterEdit.revisions.length, 2);
  assert.notEqual(afterEdit.currentRevisionId, rev1Id);
  assert.equal((await segmentService.preview({ id: segV.id })).count, 1, 'current revision = the edited rule');
  // the pinned old revision still evaluates the ORIGINAL rule
  const pinnedOld = await segmentService.resolveAudience({ id: segV.id, revisionId: rev1Id, channel: 'EMAIL', purpose: 'MARKETING' });
  assert.equal(pinnedOld.segmentCount, 2, 'revision 1 still resolves the pre-edit membership');
  results.segmentVersioning = 'PASS';

  // ============ 8. marketing audience consent gate ============
  const segAll = await mkSegment(`cohort-${tag}`, { match: 'ALL', conditions: [{ attribute: 'shipping_state', operator: 'IN', value: [SA, SB] }] });
  const aud = await segmentService.resolveAudience({ id: segAll.id, channel: 'EMAIL', purpose: 'MARKETING' });
  assert.equal(aud.segmentCount, 4);
  assert.equal(aud.marketableCount, 1, 'only C1 is GRANTED and not suppressed');
  assert.equal(aud.recipients.length, 1);
  assert.equal(aud.recipients[0].customerId, C1);
  assert.equal(aud.suppressedOrUnconsented, 3);
  results.marketingAudienceConsentGate = 'PASS';

  // consent as a rule attribute agrees with the send gate
  const segConsent = await mkSegment(`consented-${tag}`, { match: 'ALL', conditions: [
    { attribute: 'shipping_state', operator: 'IN', value: [SA, SB] },
    { attribute: 'marketing_consent', operator: 'EQ', value: true, channel: 'EMAIL', purpose: 'MARKETING' },
  ] });
  assert.equal((await segmentService.preview({ id: segConsent.id })).count, 1, 'marketing_consent attribute == audience gate');

  // ============ 9. segment-edit vs audience-resolution race ============
  const segRace = await mkSegment(`race-${tag}`, { match: 'ALL', conditions: [{ attribute: 'shipping_state', operator: 'IN', value: [SA, SB] }] });
  const pinned = segRace.currentRevisionId;
  const [, raceResolve] = await Promise.all([
    segmentService.addRevision({ id: segRace.id, definition: { match: 'ALL', conditions: [{ attribute: 'shipping_state', operator: 'EQ', value: SA }] }, staffId: created.staff[0] }),
    segmentService.resolveAudience({ id: segRace.id, revisionId: pinned, channel: 'EMAIL', purpose: 'MARKETING' }),
  ]);
  assert.equal(raceResolve.segmentCount, 4, 'pinned resolution used the old rule, not a half-applied edit');
  assert.equal((await segmentService.preview({ id: segRace.id })).count, 2, 'current now reflects the edit');
  results.segmentEditRace = 'PASS';

  // ============ 10. preview bounded + masked ============
  const prev = await segmentService.preview({ id: segAll.id, sampleSize: 10 });
  assert.ok(prev.sample.length <= 10 && prev.sample.length === 4);
  for (const row of prev.sample) {
    assert.ok(!('email' in row) && !('phone' in row), 'no raw contact fields in preview');
    assert.ok(row.name == null || /\*\*\*/.test(row.name), 'preview names are masked');
  }
  const capped = await segmentService.preview({ id: segAny.id, sampleSize: 999 });
  assert.ok(capped.sample.length <= 50, 'sample is hard-capped');
  results.segmentPreview = 'PASS';

  // ============ 11. snapshot freezes membership ============
  const snap = await segmentService.snapshot({ id: segAll.id, reason: 'HISTORICAL_PROOF', staffId: created.staff[0] });
  assert.equal(snap.memberCount, 4);
  await query('UPDATE addresses SET state = ? WHERE customer_id = ?', [`OTHER-${tag}`, C2]);
  assert.equal((await segmentService.preview({ id: segAll.id })).count, 3, 'live membership dropped C2');
  const frozen = await segmentService.repository.snapshotMemberIds(snap.snapshotId);
  assert.equal(frozen.length, 4, 'snapshot membership is frozen');
  assert.ok(frozen.includes(C2));
  results.segmentSnapshot = 'PASS';
  await query('UPDATE addresses SET state = ? WHERE customer_id = ?', [SA, C2]); // restore for clean count elsewhere

  // ============ 12. segmentsForCustomer (CMS customer view) ============
  const forC1 = await segmentService.segmentsForCustomer(C1);
  assert.ok(forC1.some((s) => s.id === segA.id), 'C1 shows in the state=SA segment');
  const forC3 = await segmentService.segmentsForCustomer(C3);
  assert.ok(!forC3.some((s) => s.id === seg2.id), 'C3 not in the SA-and-2-orders segment');
  results.segmentsForCustomer = 'PASS';

  // ============ 13. RBAC + audit + no-concat source guard ============
  assert.equal(roleHasPermission('SUPER_ADMIN', 'segments.manage'), true);
  assert.equal(roleHasPermission('ADMIN', 'segments.manage'), true);
  assert.equal(roleHasPermission('OPERATIONS', 'segments.read'), true);
  assert.equal(roleHasPermission('OPERATIONS', 'segments.manage'), false);
  assert.equal(roleHasPermission('SUPPORT', 'segments.read'), false);
  assert.equal(roleHasPermission('VIEWER', 'segments.read'), true);
  const adminRoutesSrc = readFileSync(new URL('../src/modules/segments/adminRoutes.js', import.meta.url), 'utf8');
  assert.ok(/audit\.log/.test(adminRoutesSrc) && /SEGMENT_CREATED/.test(adminRoutesSrc), 'segment mutations are audited');
  const compilerSrc = readFileSync(new URL('../src/modules/segments/ruleCompiler.js', import.meta.url), 'utf8');
  assert.ok(!/\$\{\s*value\s*\}/.test(compilerSrc), 'compiler never interpolates a value into SQL');
  assert.ok(!/\$\{\s*cond\.value\s*\}/.test(compilerSrc), 'compiler never interpolates cond.value into SQL');
  results.segmentsRbac = 'PASS';
  results.segmentsAudit = 'PASS';

  assert.equal(networkCalls, 0);
  results.realProviderCalls = 0;
  results.status = 'PASS';
  console.log('\nCUSTOMER_SEGMENTS_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nCUSTOMER_SEGMENTS_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
  const safe = async (fn) => { try { await fn(); } catch (e) { console.error('  cleanup:', e.message); } };
  for (const sid of created.segments) {
    await safe(() => query('DELETE m FROM customer_segment_snapshot_members m JOIN customer_segment_snapshots s ON s.id=m.snapshot_id WHERE s.segment_id=?', [sid]));
    await safe(() => query('DELETE FROM customer_segment_snapshots WHERE segment_id=?', [sid]));
    await safe(() => query('UPDATE customer_segments SET current_revision_id=NULL WHERE id=?', [sid]));
    await safe(() => query('DELETE FROM customer_segment_revisions WHERE segment_id=?', [sid]));
    await safe(() => query('DELETE FROM customer_segments WHERE id=?', [sid]));
  }
  for (const cid of created.customers) {
    await safe(() => query('DELETE FROM orders WHERE customer_id=?', [cid]));
    await safe(() => query('DELETE FROM consent_records WHERE customer_id=? OR contact_key=?', [cid, emailOf(cid)]));
    await safe(() => query('DELETE FROM consent_state WHERE customer_id=? OR contact_key=?', [cid, emailOf(cid)]));
    await safe(() => query('DELETE FROM marketing_suppressions WHERE contact_key=?', [emailOf(cid)]));
    await safe(() => query('DELETE FROM addresses WHERE customer_id=?', [cid]));
  }
  for (const rid of created.reservations) await safe(() => query('DELETE FROM inventory_reservations WHERE id=?', [rid]));
  for (const cid of created.customers) await safe(() => query('DELETE FROM customers WHERE id=?', [cid]));
  for (const id of created.staff) await safe(() => query('DELETE FROM staff_users WHERE id=?', [id]));
  await pool.end();
}
