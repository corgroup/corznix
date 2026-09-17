// Content document engine (Wave 8E). Every publishable content SCOPE
// (navigation, homepage, footer, announcements, mega menus, a page, an FAQ
// set, a theme, a campaign) is a `content_documents` row with:
//   - working_version : optimistic-concurrency token, bumped on every draft
//                       save. A stale save -> CONTENT_VERSION_CONFLICT.
//   - published_publication_id : the live pointer.
// Publishing snapshots the current draft into an IMMUTABLE
// `content_publications` row and advances the pointer atomically. Rollback
// writes a NEW publication whose snapshot is copied from an older one — old
// rows are never edited (§20/§21/§68).
//
// The public storefront reads exactly one row: the current publication's
// snapshot_json (version-keyed, cacheable). It never joins the draft tables.
//
// Multi-company (implementation/multi-company/DESIGN.md §4.1, Phase 3):
// `content_documents.brand_id` is the scope anchor every content_pages/
// faq_items/home_sections/footer_groups/campaigns/themes row transitively
// inherits through `document_id`. `getOrCreateDocument`/`loadDocument`/
// `publish`/`rollback`/`listPublications` take an OPTIONAL `brandId` —
// every ADMIN draft-editing service (navigationService/homepageService/
// pagesService/campaignService) always passes the caller's real
// `req.brandId`, so admin reads/writes are genuinely scoped; the PUBLIC
// preview path (resolveHeaderPreview et al, reachable only via a signed
// preview token, no `req.brandId` in scope on that public router) calls
// without one and gets the unscoped pre-Phase-3 behaviour — deferred to
// Phase 4's storefront host->brand mapping, safe today since Cor-Znix has
// zero content_documents rows. `getPublishedSnapshot` (the real public
// storefront read) stays unscoped entirely, same reasoning.
import { randomUUID } from 'node:crypto';
import { AppError } from '../../utils/errors.js';
import { query } from '../../database/connection/pool.js';
import { withTransaction } from '../../database/connection/transaction.js';

// A brandId-less create() (public/preview path) falls back to the default
// brand rather than inserting a NULL into a NOT NULL column — mirrors the
// same fallback staff/repositories.js uses for staff provisioning.
async function defaultBrandId(run) {
  const rows = await run("SELECT id FROM brands WHERE is_default = 1 AND status = 'active' LIMIT 1");
  return rows[0]?.id || null;
}

export async function getOrCreateDocument(docType, docKey = 'default', conn = null, brandId = null) {
  const run = conn ? (sql, p) => conn.execute(sql, p).then(([r]) => r) : query;
  const rows = brandId
    ? await run('SELECT * FROM content_documents WHERE doc_type = ? AND doc_key = ? AND brand_id = ? LIMIT 1', [docType, docKey, brandId])
    : await run('SELECT * FROM content_documents WHERE doc_type = ? AND doc_key = ? LIMIT 1', [docType, docKey]);
  if (rows[0]) return rows[0];
  const id = randomUUID();
  const resolvedBrandId = brandId || await defaultBrandId(run);
  await run(
    `INSERT INTO content_documents (id, brand_id, doc_type, doc_key, working_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, NOW(3), NOW(3))`,
    [id, resolvedBrandId, docType, docKey],
  );
  return (await run('SELECT * FROM content_documents WHERE id = ? LIMIT 1', [id]))[0];
}

export async function loadDocument(docType, docKey = 'default', brandId = null) {
  const doc = await getOrCreateDocument(docType, docKey, null, brandId);
  return {
    id: doc.id,
    docType: doc.doc_type,
    docKey: doc.doc_key,
    status: doc.status,
    workingVersion: doc.working_version,
    publishedVersion: doc.published_version,
    publishedPublicationId: doc.published_publication_id,
    draftDirty: Boolean(doc.draft_dirty),
    updatedAt: doc.updated_at,
  };
}

/** @throws {AppError} CONTENT_VERSION_CONFLICT */
export function assertVersion(doc, expectedVersion) {
  if (expectedVersion == null) return; // caller opted out (e.g. first-time seed)
  if (Number(expectedVersion) !== Number(doc.workingVersion)) {
    throw new AppError(
      'CONTENT_VERSION_CONFLICT',
      `This content was changed by someone else (you have v${expectedVersion}, current is v${doc.workingVersion}). Reload and re-apply your changes.`,
      409,
    );
  }
}

/** Bump the concurrency token + mark the draft dirty. Call inside the same txn as the draft mutation. */
export async function touchDraft(docId, conn) {
  const run = conn ? (sql, p) => conn.execute(sql, p) : (sql, p) => query(sql, p);
  await run('UPDATE content_documents SET working_version = working_version + 1, draft_dirty = 1, updated_at = NOW(3) WHERE id = ?', [docId]);
}

/**
 * Atomic publish. `buildSnapshot(conn, doc)` reads the draft tables and
 * returns the full public DTO for this scope; it is stored immutably.
 * @returns {Promise<{ publicationId: string, version: number }>}
 */
export async function publish({ docType, docKey = 'default', buildSnapshot, expectedVersion, staffId = null, changeSummary = null, brandId = null }) {
  return withTransaction(async (conn) => {
    const [docRows] = brandId
      ? await conn.execute('SELECT * FROM content_documents WHERE doc_type = ? AND doc_key = ? AND brand_id = ? LIMIT 1 FOR UPDATE', [docType, docKey, brandId])
      : await conn.execute('SELECT * FROM content_documents WHERE doc_type = ? AND doc_key = ? LIMIT 1 FOR UPDATE', [docType, docKey]);
    const doc = docRows[0] || await getOrCreateDocument(docType, docKey, conn, brandId);
    assertVersion({ workingVersion: doc.working_version }, expectedVersion);

    const snapshot = await buildSnapshot(conn, doc);
    const version = Number(doc.published_version || 0) + 1;
    const pubId = randomUUID();

    await conn.execute(
      `UPDATE content_publications SET state = 'SUPERSEDED' WHERE document_id = ? AND state = 'PUBLISHED'`,
      [doc.id],
    );
    await conn.execute(
      `INSERT INTO content_publications (id, document_id, version, state, snapshot_json, change_summary, published_by_staff_id, published_at)
       VALUES (?, ?, ?, 'PUBLISHED', CAST(? AS JSON), ?, ?, NOW(3))`,
      [pubId, doc.id, version, JSON.stringify(snapshot), changeSummary, staffId],
    );
    await conn.execute(
      'UPDATE content_documents SET published_version = ?, published_publication_id = ?, draft_dirty = 0, updated_at = NOW(3) WHERE id = ?',
      [version, pubId, doc.id],
    );
    return { publicationId: pubId, version };
  });
}

/** History, newest first. */
export async function listPublications(docType, docKey = 'default', brandId = null) {
  const doc = await loadDocument(docType, docKey, brandId);
  const rows = await query(
    `SELECT p.id, p.version, p.state, p.change_summary, p.source_publication_id, p.published_at,
       s.email_normalized AS published_by
     FROM content_publications p
     LEFT JOIN staff_users s ON s.id = p.published_by_staff_id
     WHERE p.document_id = ?
     ORDER BY p.version DESC`,
    [doc.id],
  );
  return {
    document: { docType, docKey, workingVersion: doc.workingVersion, publishedVersion: doc.publishedVersion, draftDirty: doc.draftDirty },
    publications: rows.map((r) => ({
      id: r.id, version: r.version, state: r.state, changeSummary: r.change_summary,
      sourcePublicationId: r.source_publication_id, publishedBy: r.published_by || null, publishedAt: r.published_at,
    })),
  };
}

export async function getPublication(publicationId) {
  const rows = await query('SELECT * FROM content_publications WHERE id = ? LIMIT 1', [publicationId]);
  if (!rows[0]) throw new AppError('CONTENT_PUBLICATION_NOT_FOUND', 'Publication not found.', 404);
  const snap = typeof rows[0].snapshot_json === 'string' ? JSON.parse(rows[0].snapshot_json) : rows[0].snapshot_json;
  return { id: rows[0].id, documentId: rows[0].document_id, version: rows[0].version, state: rows[0].state, snapshot: snap, publishedAt: rows[0].published_at };
}

/** The public read path — the current published snapshot for a scope, or
 * null. Unscoped by brand — see file header. */
/** The live snapshot of one company's scope (null when never published). */
export async function getPublishedSnapshotForBrand(docType, docKey, brandId) {
  const rows = await query(
    `SELECT p.snapshot_json, p.version, p.published_at
     FROM content_documents d
     JOIN content_publications p ON p.id = d.published_publication_id
     WHERE d.doc_type = ? AND d.doc_key = ? AND d.brand_id = ? LIMIT 1`,
    [docType, docKey, brandId],
  );
  if (!rows[0]) return null;
  const snap = typeof rows[0].snapshot_json === 'string' ? JSON.parse(rows[0].snapshot_json) : rows[0].snapshot_json;
  return { version: rows[0].version, publishedAt: rows[0].published_at, snapshot: snap };
}

export async function getPublishedSnapshot(docType, docKey = 'default') {
  const rows = await query(
    `SELECT p.snapshot_json, p.version
     FROM content_documents d
     JOIN content_publications p ON p.id = d.published_publication_id
     WHERE d.doc_type = ? AND d.doc_key = ? LIMIT 1`,
    [docType, docKey],
  );
  if (!rows[0]) return null;
  const snap = typeof rows[0].snapshot_json === 'string' ? JSON.parse(rows[0].snapshot_json) : rows[0].snapshot_json;
  return { version: rows[0].version, ...snap };
}

/**
 * Republish an older publication as a NEW version (§68). Optionally restores
 * the draft tables to match via `restoreDraft(conn, snapshot, doc)`.
 */
export async function rollback({ docType, docKey = 'default', targetPublicationId, restoreDraft = null, staffId = null, brandId = null }) {
  return withTransaction(async (conn) => {
    const [docRows] = brandId
      ? await conn.execute('SELECT * FROM content_documents WHERE doc_type = ? AND doc_key = ? AND brand_id = ? LIMIT 1 FOR UPDATE', [docType, docKey, brandId])
      : await conn.execute('SELECT * FROM content_documents WHERE doc_type = ? AND doc_key = ? LIMIT 1 FOR UPDATE', [docType, docKey]);
    const doc = docRows[0];
    if (!doc) throw new AppError('CONTENT_DOCUMENT_NOT_FOUND', 'Content document not found.', 404);

    const [targetRows] = await conn.execute('SELECT * FROM content_publications WHERE id = ? AND document_id = ? LIMIT 1', [targetPublicationId, doc.id]);
    if (!targetRows[0]) throw new AppError('CONTENT_PUBLICATION_NOT_FOUND', 'That publication does not belong to this content.', 404);
    const snapshot = typeof targetRows[0].snapshot_json === 'string' ? JSON.parse(targetRows[0].snapshot_json) : targetRows[0].snapshot_json;

    const version = Number(doc.published_version || 0) + 1;
    const pubId = randomUUID();
    await conn.execute(`UPDATE content_publications SET state = 'SUPERSEDED' WHERE document_id = ? AND state = 'PUBLISHED'`, [doc.id]);
    await conn.execute(
      `INSERT INTO content_publications (id, document_id, version, state, snapshot_json, source_publication_id, change_summary, published_by_staff_id, published_at)
       VALUES (?, ?, ?, 'PUBLISHED', CAST(? AS JSON), ?, ?, ?, NOW(3))`,
      [pubId, doc.id, version, JSON.stringify(snapshot), targetPublicationId, `Rolled back to v${targetRows[0].version}`, staffId],
    );

    if (restoreDraft) await restoreDraft(conn, snapshot, doc);

    await conn.execute(
      'UPDATE content_documents SET published_version = ?, published_publication_id = ?, working_version = working_version + 1, draft_dirty = 0, updated_at = NOW(3) WHERE id = ?',
      [version, pubId, doc.id],
    );
    return { publicationId: pubId, version, rolledBackFrom: targetRows[0].version };
  });
}
