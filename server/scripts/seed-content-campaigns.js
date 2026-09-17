// Backfills the DEFAULT themes + the synthetic Diwali Test Campaign from
// database/seeds/content-campaigns.json, then publishes v1 of each.
// Deterministic + idempotent (§115): the draft rows are rebuilt from the
// JSON every run; a theme/campaign is (re)published only when its resulting
// snapshot differs from what is currently live.
//
// Multi-company (implementation/multi-company/DESIGN.md §4.1, Phase 3):
// this reference JSON is Cor-Cotton's default themes/campaigns.
//
//   npm run seed:content:campaigns
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { pool, query } from '../src/database/connection/pool.js';
import { getPublishedSnapshot, publish } from '../src/modules/content/documentService.js';
import { THEME_CAMPAIGN_BUILDERS } from '../src/modules/content/campaignService.js';
import { toMysqlDateTime } from '../src/utils/otpCrypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REF = path.join(__dirname, '..', 'database', 'seeds', 'content-campaigns.json');

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])]));
  return value;
}
const stableJson = (v) => JSON.stringify(stable(v));

async function ensureDocument(docType, docKey, brandId) {
  const [row] = await query('SELECT id FROM content_documents WHERE doc_type = ? AND doc_key = ? AND brand_id = ? LIMIT 1', [docType, docKey, brandId]);
  if (row) return row.id;
  const id = randomUUID();
  await query(`INSERT INTO content_documents (id, brand_id, doc_type, doc_key, working_version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, NOW(3), NOW(3))`, [id, brandId, docType, docKey]);
  return id;
}

async function main() {
  const ref = JSON.parse(await readFile(REF, 'utf8'));
  const report = {};

  const [cotton] = await query("SELECT id FROM brands WHERE slug = 'corcotton' LIMIT 1");
  const brandId = cotton.id;

  for (const t of ref.themes) {
    const docId = await ensureDocument('THEME', t.themeKey, brandId);
    const [ex] = await query('SELECT id FROM content_themes WHERE theme_key = ? AND brand_id = ? LIMIT 1', [t.themeKey, brandId]);
    if (ex) {
      await query('UPDATE content_themes SET document_id = ?, name = ?, tokens_json = CAST(? AS JSON), is_default = ?, status = \'ACTIVE\', updated_at = NOW(3) WHERE id = ?',
        [docId, t.name, JSON.stringify(t.tokens), t.isDefault ? 1 : 0, ex.id]);
    } else {
      await query(`INSERT INTO content_themes (id, document_id, brand_id, theme_key, name, tokens_json, is_default, status, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), ?, 'ACTIVE', NOW(3), NOW(3))`,
      [randomUUID(), docId, brandId, t.themeKey, t.name, JSON.stringify(t.tokens), t.isDefault ? 1 : 0]);
    }
  }
  // exactly one default
  const def = ref.themes.find((t) => t.isDefault);
  if (def) {
    await query('UPDATE content_themes SET is_default = 0 WHERE theme_key <> ? AND brand_id = ?', [def.themeKey, brandId]);
    await query('UPDATE content_themes SET is_default = 1 WHERE theme_key = ? AND brand_id = ?', [def.themeKey, brandId]);
  }

  for (const c of ref.campaigns) {
    const docId = await ensureDocument('CAMPAIGN', c.slug, brandId);
    const starts = toMysqlDateTime(new Date(c.startsAt));
    const ends = toMysqlDateTime(new Date(c.endsAt));
    const payload = JSON.stringify({ announcementMode: c.payload.announcementMode || 'prepend', announcements: c.payload.announcements || [], banner: c.payload.banner || null });
    const [ex] = await query('SELECT id, status FROM content_campaigns WHERE slug = ? AND brand_id = ? LIMIT 1', [c.slug, brandId]);
    if (ex) {
      await query(`UPDATE content_campaigns SET document_id = ?, campaign_key = ?, name = ?, priority = ?, starts_at = ?, ends_at = ?, theme_key = ?, payload_json = CAST(? AS JSON), updated_at = NOW(3) WHERE id = ?`,
        [docId, c.campaignKey, c.name, c.priority, starts, ends, c.themeKey || null, payload, ex.id]);
    } else {
      await query(`INSERT INTO content_campaigns (id, document_id, brand_id, campaign_key, name, slug, priority, starts_at, ends_at, theme_key, payload_json, status, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), 'DRAFT', NOW(3), NOW(3))`,
      [randomUUID(), docId, brandId, c.campaignKey, c.name, c.slug, c.priority, starts, ends, c.themeKey || null, payload]);
    }
  }

  // publish if changed
  for (const t of ref.themes) {
    const current = await getPublishedSnapshot('THEME', t.themeKey);
    const built = await THEME_CAMPAIGN_BUILDERS.theme(t.themeKey, brandId);
    if (current) { const c = { ...current }; delete c.version; if (stableJson(c) === stableJson(built)) { report[`theme:${t.themeKey}`] = `unchanged (v${current.version})`; continue; } }
    const res = await publish({ docType: 'THEME', docKey: t.themeKey, expectedVersion: null, brandId, buildSnapshot: () => built, changeSummary: current ? 'Re-seeded theme' : 'Seeded theme' });
    report[`theme:${t.themeKey}`] = `published v${res.version}`;
  }
  for (const c of ref.campaigns) {
    const current = await getPublishedSnapshot('CAMPAIGN', c.slug);
    const built = await THEME_CAMPAIGN_BUILDERS.campaign(c.slug, brandId);
    if (current) { const cur = { ...current }; delete cur.version; if (stableJson(cur) === stableJson(built)) { report[`campaign:${c.slug}`] = `unchanged (v${current.version})`; continue; } }
    const res = await publish({ docType: 'CAMPAIGN', docKey: c.slug, expectedVersion: null, brandId, buildSnapshot: () => built, changeSummary: current ? 'Re-seeded campaign' : 'Seeded campaign' });
    await query('UPDATE content_campaigns SET status = \'SCHEDULED\' WHERE slug = ? AND brand_id = ? AND status = \'DRAFT\'', [c.slug, brandId]);
    report[`campaign:${c.slug}`] = `published v${res.version}`;
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => pool.end());
