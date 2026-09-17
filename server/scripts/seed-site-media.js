// Seeds the storefront's site-media slots (hero videos + banners) from the
// media registry, so the storefront stops bundling local image/video files.
//
//  * home_hero_1 / home_hero_2 — REUSE existing Cloudinary videos. No upload,
//    no duplication. Provider ownership stays `cloudinary`.
//  * auth_banner — REUSE an existing Cloudinary product photo (white tee front).
//  * promo_banner — the only asset without a Cloudinary copy: uploaded ONCE
//    through MediaService -> CloudinaryAdapter, only if not already present.
//
// Idempotent. Run BEFORE deleting apps/corcotton/src/assets/{images,videos}.
//
//   npm run seed:site-media
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query } from '../src/database/connection/pool.js';
import { registerExistingAsset, uploadMedia, findMediaByUrl, removeMediaAsset } from '../src/modules/media/service.js';
import { setSiteMedia } from '../src/modules/content/service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The approved promo banner is no longer bundled in the storefront (Wave 8D
// asset cleanup). Point PROMO_BANNER_SRC at a temporary local copy of the
// approved image to seed the slot; it is upload INPUT only and never becomes
// storefront authority (the media row + site_media slot do).
const bannerPath = process.env.PROMO_BANNER_SRC
  || path.join(__dirname, '..', '..', 'apps', 'corcotton', 'src', 'assets', 'images', 'web-banner.png');

const HERO_1_URL = 'https://res.cloudinary.com/su6typhx/video/upload/v1787780454/corcotton/products/oversized-cotton-tee/cgbk3uinujhdih2htau8.mp4';
const HERO_2_URL = 'https://res.cloudinary.com/su6typhx/video/upload/v1787743121/Women-collection.mp4';
// White tee front — the editorial photo Login.jsx currently imports locally.
const AUTH_BANNER_EXTERNAL_ID_FRAGMENT = 'ynmyhdjz2lbw8ia5nunm';

const report = { EXISTING_VIDEO_REUSED: 0, DUPLICATE_VIDEO_UPLOADS: 0, REAL_MEDIA_PROVIDER_CALLS: 0 };

async function main() {
  const brand = (await query("SELECT id FROM brands WHERE slug = 'corcotton' LIMIT 1"))[0];
  if (!brand) throw new Error('corcotton brand missing');

  // ---- home_hero_1 — existing product/collection video ----------------
  let hero1 = await findMediaByUrl(HERO_1_URL);
  if (!hero1) {
    hero1 = await registerExistingAsset({
      url: HERO_1_URL, brandId: brand.id, externalId: 'corcotton/products/oversized-cotton-tee/cgbk3uinujhdih2htau8',
      resourceType: 'video', format: 'mp4', altText: 'CORCOTTON oversized cotton tee — motion',
    });
  }
  report.EXISTING_VIDEO_REUSED += 1;
  await setSiteMedia('home_hero_1', hero1.id, { altText: 'Comfort is not a compromise. It is a choice.', brandId: brand.id });
  console.log(`home_hero_1 -> ${hero1.id} (${hero1.providerKey}) [reused]`);

  // ---- home_hero_2 — existing Women-collection video -----------------
  let hero2 = await findMediaByUrl(HERO_2_URL);
  if (!hero2) {
    hero2 = await registerExistingAsset({
      url: HERO_2_URL, brandId: brand.id, externalId: 'Women-collection',
      resourceType: 'video', format: 'mp4', altText: 'CORCOTTON women collection — motion',
    });
  }
  report.EXISTING_VIDEO_REUSED += 1;
  await setSiteMedia('home_hero_2', hero2.id, { altText: 'Natural fabrics. Timeless design. Everyday luxury.', brandId: brand.id });
  console.log(`home_hero_2 -> ${hero2.id} (${hero2.providerKey}) [reused, registered existing URL]`);

  // ---- auth_banner — existing white tee front photo ----------------
  const authRow = (await query(
    "SELECT id FROM media WHERE external_id LIKE ? AND status = 'ACTIVE' LIMIT 1",
    [`%${AUTH_BANNER_EXTERNAL_ID_FRAGMENT}%`],
  ))[0];
  if (authRow) {
    await setSiteMedia('auth_banner', authRow.id, { altText: '', brandId: brand.id });
    console.log(`auth_banner -> ${authRow.id} [reused existing product photo]`);
  } else {
    console.log('auth_banner -> SKIP (white-tee front asset not found in registry)');
  }

  // ---- promo_banner — upload once if absent -----------------------
  const bannerByFilename = (await query(
    "SELECT id, url FROM media WHERE (original_filename = 'web-banner.png' OR url LIKE '%web-banner%') AND status = 'ACTIVE' LIMIT 1",
  ))[0];
  if (bannerByFilename) {
    await setSiteMedia('promo_banner', bannerByFilename.id, { altText: '', brandId: brand.id });
    console.log(`promo_banner -> ${bannerByFilename.id} [already in registry, no upload]`);
  } else {
    report.REAL_MEDIA_PROVIDER_CALL_ATTEMPTS = 0;
    report.REAL_MEDIA_PROVIDER_SUCCESSFUL_UPLOADS = 0;
    report.REAL_MEDIA_ASSETS_CREATED = 0;
    let uploaded = null;
    try {
      const buffer = await readFile(bannerPath).catch(() => null);
      if (!buffer) throw new Error(`local promo-banner source not found at ${bannerPath} — provide a temporary copy of the approved banner and re-run`);
      // Real network call to Cloudinary through the provider-neutral
      // MediaService boundary. A 401/other error still counts as an ATTEMPT.
      report.REAL_MEDIA_PROVIDER_CALL_ATTEMPTS = 1;
      uploaded = await uploadMedia(buffer, {
        brandId: brand.id, folder: 'corcotton/site', originalFilename: 'web-banner.png',
      });
      report.REAL_MEDIA_PROVIDER_SUCCESSFUL_UPLOADS = 1;
      report.REAL_MEDIA_ASSETS_CREATED = 1;
      report.REAL_MEDIA_PROVIDER_CALLS = 1;
      try {
        await setSiteMedia('promo_banner', uploaded.id, { altText: '', brandId: brand.id });
      } catch (bindErr) {
        // Upload succeeded but the slot bind failed — the new asset is
        // now an unreferenced orphan. Best-effort cleanup (§15).
        console.log('promo_banner -> slot bind FAILED after a successful upload; cleaning up the orphan asset');
        await removeMediaAsset(uploaded.id, { force: true }).catch((e) => {
          console.log(`  orphan cleanup FAILED — media ${uploaded.id} left for manual follow-up: ${e.message}`);
        });
        throw bindErr;
      }
      console.log(`promo_banner -> ${uploaded.id} [UPLOADED via MediaService -> CloudinaryAdapter, 1 real successful upload]`);
    } catch (err) {
      report.PROMO_BANNER_UNSEEDED = err.cause?.message || err.cause?.cause?.message || err.message;
      report.MEDIA_PROVIDER_ERROR = err.cause?.cause?.http_code || err.cause?.http_code || null;
      console.log(`promo_banner -> UNSEEDED: ${report.PROMO_BANNER_UNSEEDED}`);
      console.log('  The provider-neutral flow is intact — only the provider call failed. Re-run with working CLOUDINARY_* creds, or bind the slot from the CMS once an asset exists.');
    }
  }

  console.log(`\n${JSON.stringify(report, null, 2)}`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => pool.end());
