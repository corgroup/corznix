// ONE-OFF, IDEMPOTENT, RERUNNABLE media migration — Wave 3.5 (see
// docs/MIGRATION.md, "Media Bundle Debt"). Uploads the real bundled
// product photography/video for the "Oversized Cotton Tee" (the only
// product with real photography — every other seeded product is
// GRADIENT-only, see server/scripts/seed.js) to the configured media
// provider via server/src/platform/media (never the Cloudinary SDK
// directly — this script goes through the same abstraction any other
// server code would), then records the resulting normalized URLs as real
// `product_media` rows.
//
// WHY THIS EXISTS: apps/corcotton/src/features/catalog/fixtures/
// products.fixture.js statically imports these same files, which forces
// Vite to bundle ~108MB of real jpg/mp4 into the storefront's build output
// even though only the (now non-default, MOCK-only) fixture engine reads
// them. Once this script runs, the real backend's product_media table
// carries the same images/video as live Cloudinary URLs, which is what
// the frontend now consumes by default (see catalogService.js) — the
// locally bundled originals stop being on the storefront's critical path.
//
// RUN: node scripts/migrateProductMedia.js  (from server/)
// IDEMPOTENT: safe to re-run — skips any variant that already has an
// IMAGE/VIDEO product_media row (checked before every upload), so a
// partial run (e.g. a network failure halfway through) can simply be
// re-run rather than needing a manual cleanup pass first.
// DOES NOT FABRICATE SUCCESS: throws and exits non-zero on any upload or
// database failure — never logs "done" without a real provider response
// for each row it claims to have created.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { query } from '../src/database/connection/pool.js';
import { uploadMedia, isMediaConfigured } from '../src/platform/media/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSET_ROOT = path.resolve(__dirname, '../../apps/corcotton/src/assets');
const PRODUCT_IMAGE_DIR = path.join(ASSET_ROOT, 'images/products/oversized-cotton-tee');
const VIDEO_PATH = path.join(ASSET_ROOT, 'videos/Main-collection.mp4');

// storefrontId -> { front, secondary, video? } — mirrors
// features/catalog/fixtures/products.fixture.js's PRODUCTS_FIXTURE
// entries 1-4 exactly (Black gets the shared collection video; the others
// don't — same as the fixture).
const VARIANT_MEDIA = {
  1: { front: 'black-front.jpg', secondary: 'black-lifestyle.jpg', video: VIDEO_PATH },
  2: { front: 'white-front.jpg', secondary: 'white-style-shoot.jpg' },
  3: { front: 'beige-front.jpg', secondary: 'beige-style-shoot.jpg' },
  4: { front: 'camel-front.jpg', secondary: 'camel-lifestyle.jpg' },
};

// Per-media-type (not per-variant) so a partial prior run — e.g. images
// uploaded fine but the video failed on Cloudinary's size cap, a real
// failure this script hit during Wave 3.5 — can be resumed by re-running
// rather than being permanently skipped as "already done". IMAGE requires
// >=2 rows (front+secondary) specifically so a run that uploaded only the
// front image before failing on the secondary doesn't get mistaken for
// "done" on the next attempt.
async function countMediaOfType(variantId, mediaType) {
  const rows = await query(
    'SELECT COUNT(*) AS c FROM product_media WHERE variant_id = ? AND media_type = ?',
    [variantId, mediaType]
  );
  return Number(rows[0].c);
}

async function nextPosition(variantId) {
  const rows = await query('SELECT COALESCE(MAX(position), -1) AS maxPos FROM product_media WHERE variant_id = ?', [variantId]);
  return Number(rows[0].maxPos) + 1;
}

async function insertMediaRow({ productId, variantId, mediaType, url, altText, position }) {
  await query(
    `INSERT INTO product_media (id, product_id, variant_id, media_type, url, alt_text, position, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', NOW(), NOW())`,
    [randomUUID(), productId, variantId, mediaType, url, altText, position]
  );
}

async function migrateVariant({ storefrontId, variantId, productId, colorName }) {
  const spec = VARIANT_MEDIA[storefrontId];
  if (!spec) return { storefrontId, skipped: 'no media spec' };

  const uploaded = [];
  const skippedParts = [];

  if ((await countMediaOfType(variantId, 'IMAGE')) >= 2) {
    skippedParts.push('images already present');
  } else {
    let position = await nextPosition(variantId);
    for (const [role, filename] of [['front', spec.front], ['secondary', spec.secondary]]) {
      const filePath = path.join(PRODUCT_IMAGE_DIR, filename);
      const buffer = await readFile(filePath);
      // Explicit resourceType: a couple of these photos are >10MB
      // (Cloudinary's un-chunked upload cap — see cloudinaryProvider.js),
      // which routes them through the chunked path; that path doesn't
      // support "auto" content-sniffing the way normal uploads do, so a
      // real type must always be given here.
      const media = await uploadMedia(buffer, { folder: 'corcotton/products/oversized-cotton-tee', resourceType: 'image' });
      await insertMediaRow({
        productId, variantId, mediaType: 'IMAGE', url: media.url,
        altText: `Oversized Cotton Tee — ${colorName} (${role})`, position: position++,
      });
      uploaded.push({ role, url: media.url });
    }
  }

  if (spec.video) {
    if ((await countMediaOfType(variantId, 'VIDEO')) >= 1) {
      skippedParts.push('video already present');
    } else {
      const position = await nextPosition(variantId);
      const buffer = await readFile(spec.video);
      const media = await uploadMedia(buffer, { folder: 'corcotton/products/oversized-cotton-tee', resourceType: 'video' });
      await insertMediaRow({
        productId, variantId, mediaType: 'VIDEO', url: media.url,
        altText: 'Oversized Cotton Tee — collection video', position,
      });
      uploaded.push({ role: 'video', url: media.url });
    }
  }

  return { storefrontId, uploaded: uploaded.length, skipped: skippedParts.length ? skippedParts.join(', ') : undefined };
}

async function main() {
  if (!isMediaConfigured()) {
    console.error('[migrateProductMedia] Media provider is not configured (missing CLOUDINARY_* env vars). Aborting — refusing to fabricate a migration.');
    process.exitCode = 1;
    return;
  }

  const variants = await query(
    `SELECT v.storefront_id AS storefrontId, v.id AS variantId, v.product_id AS productId, v.color_name AS colorName
     FROM product_variants v JOIN products p ON p.id = v.product_id
     WHERE p.slug = 'oversized-cotton-tee' ORDER BY v.storefront_id`
  );

  if (variants.length === 0) {
    console.error('[migrateProductMedia] No "oversized-cotton-tee" variants found — has `npm run seed` been run?');
    process.exitCode = 1;
    return;
  }

  const results = [];
  let hadFailure = false;
  for (const v of variants) {
    // Sequential, not Promise.all: keeps upload order deterministic and
    // avoids hammering the provider with 9 concurrent uploads from a
    // one-off script. One variant's genuine failure (e.g. a source photo
    // that exceeds this Cloudinary plan's per-asset size cap — a real
    // constraint hit during Wave 3.5, not a bug) must not block every
    // other variant from migrating — each is independent real content.
    try {
      // eslint-disable-next-line no-await-in-loop
      results.push(await migrateVariant(v));
    } catch (err) {
      hadFailure = true;
      results.push({ storefrontId: v.storefrontId, failed: err.message || String(err) });
    }
  }

  console.log('[migrateProductMedia] Done:', JSON.stringify(results, null, 2));
  if (hadFailure) {
    console.error('[migrateProductMedia] One or more variants failed — see "failed" entries above. Re-running is safe (idempotent) once the underlying issue is fixed.');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[migrateProductMedia] FAILED:', err);
  process.exitCode = 1;
});
