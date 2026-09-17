// Does every ACTIVE media row actually resolve at the provider?
//
// The registry can drift from the provider in both directions: an asset can be
// deleted at the provider while the row stays ACTIVE, and (before the
// verification added to registerExistingAsset) a row could be written for an
// asset that was never there. Either way the storefront renders a broken
// <img>, and nothing in the database looks wrong — the row is ACTIVE, the URL
// is well-formed, and the product page loads.
//
// This is the only check here that makes real outbound requests, so it is a
// deliberate operator/CI-with-network tool rather than part of the offline
// suite. It is read-only: it never edits or archives anything.
//
//   npm run verify:media-integrity
import { query, pool } from '../src/database/connection/pool.js';

const TIMEOUT_MS = 8000;
const CONCURRENCY = 6;

const head = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { method: 'HEAD', signal: controller.signal });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, status: e.name === 'AbortError' ? 'TIMEOUT' : 'UNREACHABLE' };
  } finally { clearTimeout(timer); }
};

const rows = await query(
  `SELECT m.id, m.url, m.provider_key, m.resource_type, m.external_id, b.slug AS brand,
          (SELECT COUNT(*) FROM product_media pm WHERE pm.media_id = m.id) AS product_refs,
          (SELECT COUNT(*) FROM site_media sm WHERE sm.media_id = m.id) AS site_refs
     FROM media m
     LEFT JOIN brands b ON b.id = m.brand_id
    WHERE m.status = 'ACTIVE'
    ORDER BY b.slug, m.resource_type, m.external_id`);

const results = [];
for (let i = 0; i < rows.length; i += CONCURRENCY) {
  const batch = rows.slice(i, i + CONCURRENCY);
  // eslint-disable-next-line no-await-in-loop
  const checked = await Promise.all(batch.map(async (r) => ({ ...r, ...(await head(r.url)) })));
  results.push(...checked);
}

const broken = results.filter((r) => !r.ok);
const referencedBroken = broken.filter((r) => Number(r.product_refs) + Number(r.site_refs) > 0);

console.log(`\nchecked ${results.length} ACTIVE media row(s) against their provider\n`);
for (const r of results) {
  const refs = Number(r.product_refs) + Number(r.site_refs);
  console.log(`  ${r.ok ? 'OK  ' : 'GONE'}  ${String(r.status).padEnd(11)} ${r.brand || '(no brand)'} · ${r.resource_type} · ${refs} ref(s)  ${r.external_id || r.url}`);
}

console.log('\n──── media integrity ────');
console.log(JSON.stringify({
  ACTIVE_MEDIA_ROWS: results.length,
  RESOLVING: results.length - broken.length,
  NOT_AT_PROVIDER: broken.length,
  // The ones that actually reach a customer: a dangling row nothing references
  // is untidy; a dangling row a PDP renders is a broken image on the storefront.
  NOT_AT_PROVIDER_AND_REFERENCED: referencedBroken.length,
}, null, 2));

if (broken.length) {
  console.log('\nEvery row above marked GONE is ACTIVE in the registry but not served by the provider.');
  console.log('Resolve each by either re-uploading the original asset under the same public id,');
  console.log('or archiving the row so the storefront stops rendering a broken image.');
  console.log('This script never does either automatically — both destroy or alter merchandising.');
}

console.log(`\nMEDIA_INTEGRITY = ${broken.length === 0 ? 'PASS' : 'FAIL'}`);
process.exitCode = broken.length === 0 ? 0 : 1;
await pool.end();
