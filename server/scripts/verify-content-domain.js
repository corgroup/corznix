// Content document engine (Wave 8E, Phase 2).
//
// Proves the generic publish / revision / pointer / optimistic-concurrency
// / rollback engine that every content type builds on:
//   CONTENT_DOCUMENT_LIFECYCLE, OPTIMISTIC_CONCURRENCY (CONTENT_VERSION_CONFLICT),
//   IMMUTABLE_PUBLICATIONS, PUBLISHED_POINTER, ROLLBACK (new version, old
//   publication untouched, draft restored).
//
// Pure DB, no HTTP, no network. Self-cleaning.
//
//   npm run verify:content:domain
import assert from 'node:assert/strict';

const { pool, query } = await import('../src/database/connection/pool.js');
const svc = await import('../src/modules/content/documentService.js');

const results = {};
const pass = (n, note) => { results[n] = note ? `PASS (${note})` : 'PASS'; console.log(`  PASS  ${n}${note ? ` — ${note}` : ''}`); };

const DOC_TYPE = 'THEME';
const DOC_KEY = `verify-domain-${Date.now()}`;

async function cleanup() {
  await query('DELETE FROM content_documents WHERE doc_type = ? AND doc_key = ?', [DOC_TYPE, DOC_KEY]).catch(() => {});
  await pool.end();
}

try {
  // ---- 1. create + version token ---------------------------------
  let doc = await svc.loadDocument(DOC_TYPE, DOC_KEY);
  assert.equal(doc.workingVersion, 1);
  assert.equal(doc.publishedVersion, null);
  assert.equal(doc.draftDirty, false);

  await svc.touchDraft(doc.id);
  doc = await svc.loadDocument(DOC_TYPE, DOC_KEY);
  assert.equal(doc.workingVersion, 2, 'draft save bumps working_version');
  assert.equal(doc.draftDirty, true);
  pass('CONTENT_DOCUMENT_LIFECYCLE');

  // ---- 2. optimistic concurrency --------------------------------
  assert.throws(() => svc.assertVersion(doc, 1), (e) => e.code === 'CONTENT_VERSION_CONFLICT' && e.status === 409);
  assert.doesNotThrow(() => svc.assertVersion(doc, 2));
  // publish with a stale expectedVersion is rejected
  await assert.rejects(
    () => svc.publish({ docType: DOC_TYPE, docKey: DOC_KEY, expectedVersion: 1, buildSnapshot: async () => ({ tokens: {} }) }),
    (e) => e.code === 'CONTENT_VERSION_CONFLICT',
  );
  pass('OPTIMISTIC_CONCURRENCY');

  // ---- 3. publish -> immutable snapshot + pointer --------------
  const p1 = await svc.publish({
    docType: DOC_TYPE, docKey: DOC_KEY, expectedVersion: 2,
    buildSnapshot: async () => ({ tokens: { accent: '#111' }, note: 'v1' }),
    changeSummary: 'first publish',
  });
  assert.equal(p1.version, 1);
  doc = await svc.loadDocument(DOC_TYPE, DOC_KEY);
  assert.equal(doc.publishedVersion, 1);
  assert.equal(doc.publishedPublicationId, p1.publicationId);
  assert.equal(doc.draftDirty, false, 'publish clears draft_dirty');

  const snap = await svc.getPublishedSnapshot(DOC_TYPE, DOC_KEY);
  assert.equal(snap.version, 1);
  assert.equal(snap.tokens.accent, '#111');
  pass('PUBLISHED_POINTER');

  // ---- 4. second publish supersedes ---------------------------
  await svc.touchDraft(doc.id);
  doc = await svc.loadDocument(DOC_TYPE, DOC_KEY);
  const p2 = await svc.publish({
    docType: DOC_TYPE, docKey: DOC_KEY, expectedVersion: doc.workingVersion,
    buildSnapshot: async () => ({ tokens: { accent: '#222' }, note: 'v2' }),
    changeSummary: 'second publish',
  });
  assert.equal(p2.version, 2);
  const hist = await svc.listPublications(DOC_TYPE, DOC_KEY);
  assert.deepEqual(hist.publications.map((x) => [x.version, x.state]), [[2, 'PUBLISHED'], [1, 'SUPERSEDED']]);
  assert.equal((await svc.getPublishedSnapshot(DOC_TYPE, DOC_KEY)).tokens.accent, '#222');

  // v1's stored snapshot is untouched
  const p1full = await svc.getPublication(p1.publicationId);
  assert.equal(p1full.snapshot.tokens.accent, '#111', 'old publication snapshot immutable');
  pass('IMMUTABLE_PUBLICATIONS');

  // ---- 5. rollback -> new version from old snapshot -----------
  let restored = null;
  const rb = await svc.rollback({
    docType: DOC_TYPE, docKey: DOC_KEY, targetPublicationId: p1.publicationId,
    restoreDraft: async (_conn, snapshot) => { restored = snapshot; },
  });
  assert.equal(rb.version, 3, 'rollback creates a new version');
  assert.equal(rb.rolledBackFrom, 1);
  assert.equal(restored.tokens.accent, '#111', 'restoreDraft callback got the rolled-back snapshot');

  const afterRb = await svc.listPublications(DOC_TYPE, DOC_KEY);
  assert.deepEqual(afterRb.publications.map((x) => x.version), [3, 2, 1]);
  assert.equal(afterRb.publications[0].sourcePublicationId, p1.publicationId, 'rollback records its lineage');
  assert.equal((await svc.getPublishedSnapshot(DOC_TYPE, DOC_KEY)).tokens.accent, '#111', 'live content is the rolled-back state');
  // p1 still SUPERSEDED, its snapshot still intact
  assert.equal((await svc.getPublication(p1.publicationId)).snapshot.tokens.accent, '#111');
  pass('ROLLBACK');

  console.log('\nCONTENT_DOMAIN_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nCONTENT_DOMAIN_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  await cleanup();
}
