// Campaign + Theme engine (Wave 8E, Phase 6).
//
//   THEME    — a CONSTRAINED token map (fixed whitelist of names, each a
//              plain hex colour; there is no arbitrary-CSS path). One theme
//              is the default/base.
//   CAMPAIGN — a scheduled overlay: a window [startsAt, endsAt), a priority,
//              an optional theme, and a bounded announcement/banner payload.
//
// ContentResolutionService.resolveExperience(now) is REQUEST-TIME: it reads
// the published campaign snapshots and overlays whichever windows contain
// `now`, highest priority winning (deterministic tie-break). No cron.
// content_campaign_runtime is an out-of-band kill switch checked here too.
//
// Multi-company (implementation/multi-company/DESIGN.md §4.1, Phase 3):
// draft-editing functions take the caller's `brandId`. `resolveExperience`
// (the public request-time resolver) stays unscoped — deferred to Phase 4,
// same as every other public resolver in this module.
//
// Multi-company (DESIGN.md §4.1) — Phase 4: `content_campaign_runtime` (the
// kill-switch table, previously a KNOWN GAP left by Phase 3 — it wasn't in
// DESIGN.md's table list at all) now has `brand_id` too (migration 079,
// composite PK). The two ADMIN-scoped lookups below (list + draft) join on
// it with brand_id now, closing the cross-brand collision risk. The public
// `resolveExperience`/`activeCampaigns` resolver deliberately stays
// unscoped here — same boundary Phase 3 drew for every public resolver in
// this module (see line ~15) — carried forward to whichever phase closes
// the full storefront-read gap; safe today, Cor-Znix has zero campaigns.
import { randomUUID, createHash } from 'node:crypto';
import { AppError } from '../../utils/errors.js';
import { query } from '../../database/connection/pool.js';
import { withTransaction } from '../../database/connection/transaction.js';
import {
  loadDocument, touchDraft, assertVersion, publish, rollback,
  listPublications, getPublishedSnapshot,
} from './documentService.js';
import { validateInternalTarget } from './linkSafety.js';
import { toMysqlDateTime } from '../../utils/otpCrypto.js';
import { StaffAuditRepository } from '../staff/repositories.js';

const auditRepo = new StaffAuditRepository();
const audit = (actor, action, rt, rid, meta) => auditRepo.log({
  staffUserId: actor?.id || null, actorEmail: actor?.email || null, ipAddress: actor?.ip || null,
  requestId: actor?.requestId || null, action, resourceType: rt, resourceId: String(rid), metadata: meta,
}).catch(() => {});
const parseJson = (v) => (v == null ? {} : (typeof v === 'string' ? JSON.parse(v) : v));
const str = (v, min, max) => typeof v === 'string' && v.trim().length >= min && v.length <= max;
const KEY_RE = /^[a-z][a-z0-9_]*$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function toDt(value, field) {
  if (value == null || value === '') throw new AppError('CONTENT_INVALID', `${field} is required.`, 422);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new AppError('CONTENT_INVALID', `"${value}" is not a valid date/time.`, 422);
  return { mysql: toMysqlDateTime(d), iso: d.toISOString(), date: d };
}

// ---- theme tokens (the whole constrained surface) ------------------------

export const THEME_TOKENS = {
  announcementBg: '--cor-announcement-bg',
  announcementFg: '--cor-announcement-fg',
  accent: '--cor-accent',
  accentContrast: '--cor-accent-contrast',
  bannerBg: '--cor-banner-bg',
  bannerFg: '--cor-banner-fg',
};
export const DEFAULT_TOKENS = {
  announcementBg: '#000000',
  announcementFg: '#ffffff',
  accent: '#000000',
  accentContrast: '#ffffff',
  bannerBg: '#111111',
  bannerFg: '#ffffff',
};
const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function validateTokens(tokens) {
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) throw new AppError('CONTENT_INVALID', 'tokens must be an object.', 422);
  const out = {};
  for (const [k, v] of Object.entries(tokens)) {
    if (!(k in THEME_TOKENS)) throw new AppError('CONTENT_INVALID', `Unknown theme token "${k}". Allowed: ${Object.keys(THEME_TOKENS).join(', ')}.`, 422);
    if (typeof v !== 'string' || !HEX.test(v.trim())) throw new AppError('CONTENT_INVALID', `Theme token "${k}" must be a hex colour (got "${v}").`, 422);
    out[k] = v.trim().toLowerCase();
  }
  return out;
}

// ---- THEME scope --------------------------------------------------------

const themeScope = (key) => {
  if (!KEY_RE.test(key || '')) throw new AppError('CONTENT_INVALID', `Invalid theme key "${key}".`, 422);
  return { docType: 'THEME', docKey: key };
};

export async function listThemes(brandId) {
  const rows = await query(
    `SELECT t.*, d.working_version, d.published_version, d.draft_dirty
     FROM content_themes t JOIN content_documents d ON d.id = t.document_id
     WHERE t.brand_id = ?
     ORDER BY t.is_default DESC, t.name ASC`,
    [brandId],
  );
  return {
    tokenNames: Object.keys(THEME_TOKENS),
    defaultTokens: DEFAULT_TOKENS,
    themes: rows.map((t) => ({
      themeKey: t.theme_key, name: t.name, tokens: parseJson(t.tokens_json), isDefault: Boolean(t.is_default),
      status: t.status, workingVersion: t.working_version, publishedVersion: t.published_version, draftDirty: Boolean(t.draft_dirty),
    })),
  };
}

async function themeRow(key, brandId) {
  const rows = brandId
    ? await query('SELECT * FROM content_themes WHERE theme_key = ? AND brand_id = ? LIMIT 1', [key, brandId])
    : await query('SELECT * FROM content_themes WHERE theme_key = ? LIMIT 1', [key]);
  const t = rows[0];
  if (!t) throw new AppError('CONTENT_THEME_NOT_FOUND', `No theme "${key}".`, 404);
  return t;
}

export async function getThemeDraft(key, brandId) {
  const t = await themeRow(key, brandId);
  const doc = await loadDocument('THEME', key, brandId);
  return {
    document: { docType: doc.docType, docKey: doc.docKey, workingVersion: doc.workingVersion, publishedVersion: doc.publishedVersion, draftDirty: doc.draftDirty },
    tokenNames: Object.keys(THEME_TOKENS),
    theme: { themeKey: t.theme_key, name: t.name, tokens: parseJson(t.tokens_json), isDefault: Boolean(t.is_default), status: t.status },
  };
}

export async function createTheme(input, actor, brandId) {
  if (!KEY_RE.test(input.themeKey || '')) throw new AppError('CONTENT_INVALID', 'themeKey must be lower_snake_case.', 422);
  if (!str(input.name, 1, 120)) throw new AppError('CONTENT_INVALID', 'name 1–120 chars.', 422);
  const tokens = validateTokens(input.tokens || {});
  const [dupe] = await query('SELECT 1 FROM content_themes WHERE theme_key = ? AND brand_id = ? LIMIT 1', [input.themeKey, brandId]);
  if (dupe) throw new AppError('CONTENT_INVALID', 'A theme with that key already exists.', 409);

  await withTransaction(async (conn) => {
    const docId = randomUUID();
    await conn.execute(
      `INSERT INTO content_documents (id, brand_id, doc_type, doc_key, working_version, created_at, updated_at) VALUES (?, ?, 'THEME', ?, 1, NOW(3), NOW(3))`,
      [docId, brandId, input.themeKey],
    );
    await conn.execute(
      `INSERT INTO content_themes (id, document_id, brand_id, theme_key, name, tokens_json, is_default, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), 0, 'ACTIVE', NOW(3), NOW(3))`,
      [randomUUID(), docId, brandId, input.themeKey, input.name.trim(), JSON.stringify(tokens)],
    );
    await conn.execute('UPDATE content_documents SET draft_dirty = 1 WHERE id = ?', [docId]);
  });
  await audit(actor, 'CONTENT_THEME_CREATED', 'content_theme', input.themeKey, {});
  return getThemeDraft(input.themeKey, brandId);
}

export async function updateTheme(key, patch, expectedVersion, actor, brandId) {
  const t = await themeRow(key, brandId);
  const doc = await loadDocument('THEME', key, brandId);
  assertVersion(doc, expectedVersion);
  const nextTokens = patch.tokens ? { ...parseJson(t.tokens_json), ...validateTokens(patch.tokens) } : null;

  await withTransaction(async (conn) => {
    if (patch.name != null) {
      if (!str(patch.name, 1, 120)) throw new AppError('CONTENT_INVALID', 'name 1–120 chars.', 422);
      await conn.execute('UPDATE content_themes SET name = ? WHERE id = ?', [patch.name.trim(), t.id]);
    }
    if (nextTokens) await conn.execute('UPDATE content_themes SET tokens_json = CAST(? AS JSON) WHERE id = ?', [JSON.stringify(nextTokens), t.id]);
    if (patch.isDefault === true) {
      await conn.execute('UPDATE content_themes SET is_default = 0 WHERE is_default = 1 AND brand_id = ?', [brandId]);
      await conn.execute('UPDATE content_themes SET is_default = 1 WHERE id = ?', [t.id]);
    }
    if (patch.status != null) {
      if (!['ACTIVE', 'ARCHIVED'].includes(patch.status)) throw new AppError('CONTENT_INVALID', 'status ACTIVE|ARCHIVED.', 422);
      if (patch.status === 'ARCHIVED' && t.is_default) throw new AppError('CONTENT_INVALID', 'Cannot archive the default theme.', 422);
      await conn.execute('UPDATE content_themes SET status = ? WHERE id = ?', [patch.status, t.id]);
    }
    await conn.execute('UPDATE content_themes SET updated_at = NOW(3) WHERE id = ?', [t.id]);
    await touchDraft(doc.id, conn);
  });
  await audit(actor, 'CONTENT_THEME_UPDATED', 'content_theme', key, {});
  return getThemeDraft(key, brandId);
}

async function buildThemeSnapshot(key, brandId = null) {
  const t = await themeRow(key, brandId);
  return { themeKey: t.theme_key, name: t.name, tokens: parseJson(t.tokens_json), isDefault: Boolean(t.is_default) };
}
async function restoreThemeDraft(conn, snapshot, doc) {
  await conn.execute(
    'UPDATE content_themes SET name = ?, tokens_json = CAST(? AS JSON), updated_at = NOW(3) WHERE document_id = ?',
    [snapshot.name, JSON.stringify(snapshot.tokens || {}), doc.id],
  );
}

export async function publishTheme(key, expectedVersion, actor, brandId) {
  const { docType, docKey } = themeScope(key);
  await themeRow(key, brandId);
  const res = await publish({ docType, docKey, expectedVersion, staffId: actor?.id || null, brandId, buildSnapshot: () => buildThemeSnapshot(key, brandId), changeSummary: `Published theme ${key}` });
  await audit(actor, 'CONTENT_THEME_PUBLISHED', 'content_theme', key, { version: res.version });
  return res;
}
export function themeHistory(key, brandId) { const s = themeScope(key); return listPublications(s.docType, s.docKey, brandId); }
export async function rollbackTheme(key, targetPublicationId, actor, brandId) {
  const { docType, docKey } = themeScope(key);
  const res = await rollback({ docType, docKey, targetPublicationId, staffId: actor?.id || null, brandId, restoreDraft: restoreThemeDraft });
  await audit(actor, 'CONTENT_THEME_ROLLED_BACK', 'content_theme', key, res);
  return res;
}

// ---- CAMPAIGN scope ----------------------------------------------------

const campaignScope = (slug) => {
  if (!SLUG_RE.test(slug || '')) throw new AppError('CONTENT_INVALID', `Invalid campaign slug "${slug}".`, 422);
  return { docType: 'CAMPAIGN', docKey: slug };
};

async function validatePayload(payload) {
  const p = payload || {};
  const mode = p.announcementMode || 'prepend';
  if (!['prepend', 'replace'].includes(mode)) throw new AppError('CONTENT_INVALID', 'announcementMode must be prepend|replace.', 422);
  const anns = Array.isArray(p.announcements) ? p.announcements : [];
  if (anns.length > 10) throw new AppError('CONTENT_INVALID', 'At most 10 campaign announcements.', 422);
  for (const a of anns) {
    if (!str(a.text, 1, 300)) throw new AppError('CONTENT_INVALID', 'Each campaign announcement needs text (1–300).', 422);
    if (a.link != null && a.link !== '') {
      if (!a.link.startsWith('/') || a.link.includes('//')) throw new AppError('CONTENT_LINK_INVALID', 'Announcement link must be an internal /path.', 422);
    }
  }
  let banner = null;
  if (p.banner && typeof p.banner === 'object') {
    if (!str(p.banner.text, 1, 200)) throw new AppError('CONTENT_INVALID', 'banner.text 1–200 chars.', 422);
    if (p.banner.ctaLabel != null && !str(p.banner.ctaLabel, 0, 60)) throw new AppError('CONTENT_INVALID', 'banner.ctaLabel too long.', 422);
    if (p.banner.ctaPath) await validateInternalTarget('CUSTOM_INTERNAL', p.banner.ctaPath);
    banner = { text: p.banner.text.trim(), ctaLabel: p.banner.ctaLabel || null, ctaPath: p.banner.ctaPath || null };
  }
  return { announcementMode: mode, announcements: anns.map((a) => ({ text: a.text.trim(), link: a.link || null })), banner };
}

export async function listCampaigns(brandId) {
  const rows = await query(
    `SELECT c.*, d.working_version, d.published_version, d.draft_dirty,
       r.disabled AS runtime_disabled
     FROM content_campaigns c
     JOIN content_documents d ON d.id = c.document_id
     LEFT JOIN content_campaign_runtime r ON r.campaign_key = c.campaign_key AND r.brand_id = c.brand_id
     WHERE c.brand_id = ?
     ORDER BY c.starts_at DESC`,
    [brandId],
  );
  const now = Date.now();
  return {
    campaigns: rows.map((c) => ({
      campaignKey: c.campaign_key, name: c.name, slug: c.slug, priority: c.priority,
      startsAt: new Date(c.starts_at).toISOString(), endsAt: new Date(c.ends_at).toISOString(),
      themeKey: c.theme_key, status: c.status,
      workingVersion: c.working_version, publishedVersion: c.published_version, draftDirty: Boolean(c.draft_dirty),
      runtimeDisabled: Boolean(c.runtime_disabled),
      liveNow: Boolean(c.published_version) && !c.runtime_disabled
        && new Date(c.starts_at).getTime() <= now && now < new Date(c.ends_at).getTime(),
    })),
  };
}

async function campaignRow(slug, brandId) {
  const rows = brandId
    ? await query('SELECT * FROM content_campaigns WHERE slug = ? AND brand_id = ? LIMIT 1', [slug, brandId])
    : await query('SELECT * FROM content_campaigns WHERE slug = ? LIMIT 1', [slug]);
  const c = rows[0];
  if (!c) throw new AppError('CONTENT_CAMPAIGN_NOT_FOUND', `No campaign "${slug}".`, 404);
  return c;
}

export async function getCampaignDraft(slug, brandId) {
  const c = await campaignRow(slug, brandId);
  const doc = await loadDocument('CAMPAIGN', slug, brandId);
  const [rt] = await query('SELECT * FROM content_campaign_runtime WHERE campaign_key = ? AND brand_id = ? LIMIT 1', [c.campaign_key, c.brand_id]);
  return {
    document: { docType: doc.docType, docKey: doc.docKey, workingVersion: doc.workingVersion, publishedVersion: doc.publishedVersion, draftDirty: doc.draftDirty },
    campaign: {
      campaignKey: c.campaign_key, name: c.name, slug: c.slug, priority: c.priority,
      startsAt: new Date(c.starts_at).toISOString(), endsAt: new Date(c.ends_at).toISOString(),
      themeKey: c.theme_key, status: c.status, payload: parseJson(c.payload_json),
      runtime: rt ? { disabled: Boolean(rt.disabled), reason: rt.disabled_reason, disabledAt: rt.disabled_at } : { disabled: false },
    },
  };
}

export async function createCampaign(input, actor, brandId) {
  if (!KEY_RE.test(input.campaignKey || '')) throw new AppError('CONTENT_INVALID', 'campaignKey must be lower_snake_case.', 422);
  if (!SLUG_RE.test(input.slug || '')) throw new AppError('CONTENT_INVALID', 'slug must be kebab-case.', 422);
  if (!str(input.name, 1, 160)) throw new AppError('CONTENT_INVALID', 'name 1–160 chars.', 422);
  const starts = toDt(input.startsAt, 'startsAt');
  const ends = toDt(input.endsAt, 'endsAt');
  if (ends.date <= starts.date) throw new AppError('CONTENT_INVALID', 'endsAt must be after startsAt.', 422);
  const priority = Number.isInteger(input.priority) ? input.priority : 100;
  if (priority < 0 || priority > 1000) throw new AppError('CONTENT_INVALID', 'priority 0–1000.', 422);
  if (input.themeKey) await themeRow(input.themeKey, brandId);
  const payload = await validatePayload(input.payload);
  const [dupe] = await query('SELECT 1 FROM content_campaigns WHERE (campaign_key = ? OR slug = ?) AND brand_id = ? LIMIT 1', [input.campaignKey, input.slug, brandId]);
  if (dupe) throw new AppError('CONTENT_INVALID', 'A campaign with that key or slug already exists.', 409);

  await withTransaction(async (conn) => {
    const docId = randomUUID();
    await conn.execute(
      `INSERT INTO content_documents (id, brand_id, doc_type, doc_key, working_version, created_at, updated_at) VALUES (?, ?, 'CAMPAIGN', ?, 1, NOW(3), NOW(3))`,
      [docId, brandId, input.slug],
    );
    await conn.execute(
      `INSERT INTO content_campaigns (id, document_id, brand_id, campaign_key, name, slug, priority, starts_at, ends_at, theme_key, payload_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), 'DRAFT', NOW(3), NOW(3))`,
      [randomUUID(), docId, brandId, input.campaignKey, input.name.trim(), input.slug, priority, starts.mysql, ends.mysql, input.themeKey || null, JSON.stringify(payload)],
    );
    await conn.execute('UPDATE content_documents SET draft_dirty = 1 WHERE id = ?', [docId]);
  });
  await audit(actor, 'CONTENT_CAMPAIGN_CREATED', 'content_campaign', input.slug, { campaignKey: input.campaignKey });
  return getCampaignDraft(input.slug, brandId);
}

export async function updateCampaign(slug, patch, expectedVersion, actor, brandId) {
  const c = await campaignRow(slug, brandId);
  const doc = await loadDocument('CAMPAIGN', slug, brandId);
  assertVersion(doc, expectedVersion);
  const sets = [];
  const vals = [];
  if (patch.name != null) { if (!str(patch.name, 1, 160)) throw new AppError('CONTENT_INVALID', 'name 1–160 chars.', 422); sets.push('name = ?'); vals.push(patch.name.trim()); }
  if (patch.priority != null) {
    if (!Number.isInteger(patch.priority) || patch.priority < 0 || patch.priority > 1000) throw new AppError('CONTENT_INVALID', 'priority 0–1000.', 422);
    sets.push('priority = ?'); vals.push(patch.priority);
  }
  let startsD = new Date(c.starts_at);
  let endsD = new Date(c.ends_at);
  if (patch.startsAt != null) { const d = toDt(patch.startsAt, 'startsAt'); sets.push('starts_at = ?'); vals.push(d.mysql); startsD = d.date; }
  if (patch.endsAt != null) { const d = toDt(patch.endsAt, 'endsAt'); sets.push('ends_at = ?'); vals.push(d.mysql); endsD = d.date; }
  if (endsD <= startsD) throw new AppError('CONTENT_INVALID', 'endsAt must be after startsAt.', 422);
  if (patch.themeKey !== undefined) {
    if (patch.themeKey) await themeRow(patch.themeKey, brandId);
    sets.push('theme_key = ?'); vals.push(patch.themeKey || null);
  }
  if (patch.payload !== undefined) { const p = await validatePayload(patch.payload); sets.push('payload_json = CAST(? AS JSON)'); vals.push(JSON.stringify(p)); }
  if (patch.status != null) {
    if (!['DRAFT', 'SCHEDULED', 'ARCHIVED'].includes(patch.status)) throw new AppError('CONTENT_INVALID', 'status DRAFT|SCHEDULED|ARCHIVED.', 422);
    sets.push('status = ?'); vals.push(patch.status);
  }
  if (!sets.length) return getCampaignDraft(slug, brandId);

  await withTransaction(async (conn) => {
    await conn.execute(`UPDATE content_campaigns SET ${sets.join(', ')}, updated_at = NOW(3) WHERE id = ?`, [...vals, c.id]);
    await touchDraft(doc.id, conn);
  });
  await audit(actor, 'CONTENT_CAMPAIGN_UPDATED', 'content_campaign', slug, { fields: sets.map((s) => s.split(' ')[0]) });
  return getCampaignDraft(slug, brandId);
}

async function buildCampaignSnapshot(slug, brandId = null) {
  const c = await campaignRow(slug, brandId);
  let theme = null;
  if (c.theme_key) {
    const ts = await getPublishedSnapshot('THEME', c.theme_key);
    if (ts) theme = { themeKey: c.theme_key, tokens: ts.tokens || {} };
    else {
      const [row] = await query('SELECT tokens_json FROM content_themes WHERE theme_key = ? LIMIT 1', [c.theme_key]);
      if (row) theme = { themeKey: c.theme_key, tokens: parseJson(row.tokens_json), unpublished: true };
    }
  }
  return {
    campaignKey: c.campaign_key,
    name: c.name,
    slug: c.slug,
    priority: c.priority,
    startsAt: new Date(c.starts_at).toISOString(),
    endsAt: new Date(c.ends_at).toISOString(),
    themeKey: c.theme_key || null,
    theme,
    ...parseJson(c.payload_json),
  };
}
async function restoreCampaignDraft(conn, snapshot, doc) {
  await conn.execute(
    `UPDATE content_campaigns SET name = ?, priority = ?, starts_at = ?, ends_at = ?, theme_key = ?, payload_json = CAST(? AS JSON), updated_at = NOW(3)
     WHERE document_id = ?`,
    [
      snapshot.name, snapshot.priority,
      toMysqlDateTime(new Date(snapshot.startsAt)), toMysqlDateTime(new Date(snapshot.endsAt)),
      snapshot.themeKey || null,
      JSON.stringify({ announcementMode: snapshot.announcementMode || 'prepend', announcements: snapshot.announcements || [], banner: snapshot.banner || null }),
      doc.id,
    ],
  );
}

export async function publishCampaign(slug, expectedVersion, actor, brandId) {
  const { docType, docKey } = campaignScope(slug);
  await campaignRow(slug, brandId);
  const res = await publish({ docType, docKey, expectedVersion, staffId: actor?.id || null, brandId, buildSnapshot: () => buildCampaignSnapshot(slug, brandId), changeSummary: `Published campaign ${slug}` });
  await query('UPDATE content_campaigns SET status = \'SCHEDULED\' WHERE slug = ? AND brand_id = ? AND status = \'DRAFT\'', [slug, brandId]);
  await audit(actor, 'CONTENT_CAMPAIGN_PUBLISHED', 'content_campaign', slug, { version: res.version });
  return res;
}
export function campaignHistory(slug, brandId) { const s = campaignScope(slug); return listPublications(s.docType, s.docKey, brandId); }
export async function rollbackCampaign(slug, targetPublicationId, actor, brandId) {
  const { docType, docKey } = campaignScope(slug);
  const res = await rollback({ docType, docKey, targetPublicationId, staffId: actor?.id || null, brandId, restoreDraft: restoreCampaignDraft });
  await audit(actor, 'CONTENT_CAMPAIGN_ROLLED_BACK', 'content_campaign', slug, res);
  return res;
}

export async function setCampaignDisabled(slug, disabled, reason, actor, brandId) {
  const c = await campaignRow(slug, brandId);
  await query(
    `INSERT INTO content_campaign_runtime (campaign_key, brand_id, disabled, disabled_reason, disabled_by_staff_id, disabled_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ${disabled ? 'NOW(3)' : 'NULL'}, NOW(3))
     ON DUPLICATE KEY UPDATE disabled = VALUES(disabled), disabled_reason = VALUES(disabled_reason),
       disabled_by_staff_id = VALUES(disabled_by_staff_id), disabled_at = VALUES(disabled_at), updated_at = NOW(3)`,
    [c.campaign_key, brandId, disabled ? 1 : 0, disabled ? (reason || null) : null, actor?.id || null],
  );
  await audit(actor, disabled ? 'CONTENT_CAMPAIGN_DISABLED' : 'CONTENT_CAMPAIGN_REENABLED', 'content_campaign', slug, { reason: reason || null });
  return getCampaignDraft(slug, brandId);
}

// ---- ContentResolutionService ---------------------------------------

const SNAP_BUILDERS = { theme: buildThemeSnapshot, campaign: buildCampaignSnapshot };
export const THEME_CAMPAIGN_BUILDERS = SNAP_BUILDERS;

async function baseThemeTokens(includeDrafts = false) {
  const rows = await query(
    `SELECT t.theme_key FROM content_themes t
     JOIN content_documents d ON d.id = t.document_id
     WHERE t.is_default = 1 ${includeDrafts ? '' : 'AND d.published_publication_id IS NOT NULL'} LIMIT 1`,
  );
  if (!rows[0]) return { ...DEFAULT_TOKENS };
  const tokens = includeDrafts
    ? (await buildThemeSnapshot(rows[0].theme_key)).tokens
    : (await getPublishedSnapshot('THEME', rows[0].theme_key))?.tokens;
  return { ...DEFAULT_TOKENS, ...(tokens || {}) };
}

// `includeDrafts` (preview only): resolve every campaign from its current
// DRAFT definition instead of only published ones — lets staff preview a
// campaign that is scheduled but not yet published, and `asOf` lets them
// preview it as of a future instant.
async function activeCampaigns(now, includeDrafts = false) {
  const t = now.getTime();
  const active = [];
  if (includeDrafts) {
    const rows = await query(
      `SELECT c.slug, c.campaign_key, COALESCE(r.disabled, 0) AS disabled
       FROM content_campaigns c
       LEFT JOIN content_campaign_runtime r ON r.campaign_key = c.campaign_key
       WHERE c.status <> 'ARCHIVED'`,
    );
    for (const row of rows) {
      if (row.disabled) continue;
      const snap = await buildCampaignSnapshot(row.slug);
      if (new Date(snap.startsAt).getTime() <= t && t < new Date(snap.endsAt).getTime()) active.push(snap);
    }
  } else {
    const rows = await query(
      `SELECT c.slug, c.campaign_key, p.snapshot_json, COALESCE(r.disabled, 0) AS disabled
       FROM content_campaigns c
       JOIN content_documents d ON d.id = c.document_id
       JOIN content_publications p ON p.id = d.published_publication_id
       LEFT JOIN content_campaign_runtime r ON r.campaign_key = c.campaign_key`,
    );
    for (const row of rows) {
      if (row.disabled) continue;
      const snap = typeof row.snapshot_json === 'string' ? JSON.parse(row.snapshot_json) : row.snapshot_json;
      if (new Date(snap.startsAt).getTime() <= t && t < new Date(snap.endsAt).getTime()) active.push(snap);
    }
  }
  // deterministic: priority desc, then later start wins, then key asc
  active.sort((a, b) => (b.priority - a.priority) || (new Date(b.startsAt) - new Date(a.startsAt)) || a.campaignKey.localeCompare(b.campaignKey));
  return active;
}

export async function resolveExperience(opts = {}) {
  const now = opts.now instanceof Date ? opts.now : (opts.now ? new Date(opts.now) : new Date());
  const includeDrafts = Boolean(opts.includeDrafts);
  const base = await baseThemeTokens(includeDrafts);
  const active = await activeCampaigns(now, includeDrafts);
  const winner = active[0] || null;

  const tokens = winner?.theme?.tokens ? { ...base, ...winner.theme.tokens } : base;
  const announcementOverlay = winner && Array.isArray(winner.announcements) && winner.announcements.length
    ? { mode: winner.announcementMode || 'prepend', slides: winner.announcements.map((a) => ({ text: a.text, link: a.link || null })) }
    : null;
  const banner = winner?.banner || null;

  const fingerprint = createHash('sha1')
    .update(JSON.stringify({ tokens, campaign: winner?.campaignKey || null, announcementOverlay, banner }))
    .digest('hex').slice(0, 12);

  return {
    version: fingerprint,
    theme: { tokens },
    campaign: winner ? { key: winner.campaignKey, name: winner.name, slug: winner.slug, priority: winner.priority, endsAt: winner.endsAt } : null,
    activeCampaignKeys: active.map((c) => c.campaignKey),
    announcementOverlay,
    banner,
  };
}
