// Seasonal campaigns: a general Storewide Sale + the Diwali Festive Sale.
//
// Rides the two engines that already exist and are production-tested:
//   - content_campaigns (Wave 8E Phase 6)  -> the VISUAL layer: theme colours,
//     an announcement-bar slide, and a promo banner. Resolved at request time
//     by GET /api/v1/content/experience; the storefront already renders it
//     (ExperienceThemeApplier + AnnouncementBar + CampaignBanner — no new
//     frontend code needed).
//   - promotions (Wave 8G-6)               -> the MONEY layer: an AUTOMATIC,
//     no-code-required, storewide percentage discount computed by the real
//     pricing engine at checkout.
//
// These two engines are deliberately separate (content_campaigns is "visual
// only" per its own doc comment). This script pairs one of each so the
// banner promise and the actual discount are always the same story — but it
// does NOT wire them together at runtime; each is still switched on/off
// independently. See the printed runbook at the end.
//
// The Diwali CAMPAIGN (banner/theme/window) lives in
// database/seeds/content-campaigns.json and is seeded by the existing
// `npm run seed:content:campaigns` — this script runs that first so the two
// pieces never drift apart (a lesson learned: verify:content:campaigns also
// re-runs that seed as test setup, so anything Diwali-campaign-shaped defined
// only here would get silently reverted the next time that verify runs).
// This script owns: the Sale theme, the Sale campaign, and BOTH promotions.
//
// Idempotent — safe to re-run; only writes what differs from the desired state.
//
//   npm run seed:sale-diwali-campaigns
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query } from '../src/database/connection/pool.js';
import * as campaigns from '../src/modules/content/campaignService.js';
import { promotionService } from '../src/modules/promotions/service.js';
import { toMysqlDateTime } from '../src/utils/otpCrypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAY = 24 * 60 * 60 * 1000;
const now = new Date();
const iso = (d) => d.toISOString();
// content_campaigns' service accepts ISO (it parses with `new Date()` itself);
// promotions.starts_at/ends_at are written straight through — needs MySQL form.
const sql = (isoString) => toMysqlDateTime(new Date(isoString));

// ---- a subtle "sale" accent theme (red badge, everything else = base) -----
const SALE_THEME = {
  themeKey: 'sale',
  name: 'Storewide Sale',
  tokens: {
    announcementBg: '#7a1414',
    announcementFg: '#ffffff',
    accent: '#c81e1e',
    accentContrast: '#ffffff',
    bannerBg: '#7a1414',
    bannerFg: '#ffffff',
  },
};

// ---- the Storewide Sale (money-affecting -> ships DRAFT/unpublished) ------
const SALE = {
  campaignKey: 'seasonal_sale',
  slug: 'seasonal-sale',
  name: 'Storewide Sale',
  priority: 50,
  startsAt: iso(now),
  endsAt: iso(new Date(now.getTime() + 14 * DAY)),
  themeKey: 'sale',
  payload: {
    announcementMode: 'prepend',
    announcements: [{ text: 'Storewide Sale — 15% off everything, no code needed', link: '/bestsellers' }],
    banner: { text: 'Storewide Sale — 15% off everything', ctaLabel: 'Shop the sale', ctaPath: '/bestsellers' },
  },
};
const SALE_PROMOTION = {
  name: 'Storewide Sale — 15% Off',
  description: 'Automatic 15% off the order subtotal, storewide. Pairs with the "Storewide Sale" content campaign banner.',
  triggerType: 'AUTOMATIC',
  discountType: 'PERCENTAGE',
  discountScope: 'ORDER',
  discountValue: 1500, // 15.00%
  startsAt: sql(SALE.startsAt),
  endsAt: sql(SALE.endsAt),
  usageLimitPerCustomer: 999,
  stackable: false,
  priority: 100,
  restorePolicy: 'CONFIG_REQUIRED',
};

// ---- Diwali Festive Sale — PROMOTION only (future-dated -> safe to ACTIVATE
// now, it stays inert until the window opens). The campaign half is in
// database/seeds/content-campaigns.json, seeded just below.
// Diwali 2026 is Sunday 8 Nov (5-day festival 6-10 Nov). A 26 Oct - 13 Nov
// window covers festive gifting lead-time plus a few post-Diwali days.
const DIWALI_STARTS = '2026-10-26T00:00:00.000Z';
const DIWALI_ENDS = '2026-11-13T00:00:00.000Z';
const DIWALI_PROMOTION = {
  name: 'Diwali Festive Sale — 20% Off',
  description: 'Automatic 20% off the order subtotal during the Diwali festive window. Future-dated — inert until the window opens, so safe to activate now.',
  triggerType: 'AUTOMATIC',
  discountType: 'PERCENTAGE',
  discountScope: 'ORDER',
  discountValue: 2000, // 20.00%
  startsAt: sql(DIWALI_STARTS),
  endsAt: sql(DIWALI_ENDS),
  usageLimitPerCustomer: 999,
  stackable: false,
  priority: 90, // outranks the generic sale if both windows ever overlap
  restorePolicy: 'CONFIG_REQUIRED',
};

const report = {};

// Campaigns/themes are per-company (content_documents is keyed by brand_id).
// These seeded campaigns belong to CORCOTTON.
const [brandRow] = await query("SELECT id FROM brands WHERE slug = 'corcotton' LIMIT 1");
if (!brandRow) throw new Error("seed: brand 'corcotton' missing — run npm run seed first");
const BRAND_ID = brandRow.id;

try {
  // ---- Diwali campaign (canonical source: content-campaigns.json) ----
  execSync('node scripts/seed-content-campaigns.js', { cwd: path.join(__dirname, '..'), stdio: 'ignore' });
  report.diwaliCampaign = 'seeded from database/seeds/content-campaigns.json (canonical — edit there)';

  // ---- theme ---------------------------------------------------------
  const existingThemes = (await campaigns.listThemes(BRAND_ID)).themes.map((t) => t.themeKey);
  if (!existingThemes.includes(SALE_THEME.themeKey)) {
    await campaigns.createTheme(SALE_THEME, null, BRAND_ID);
    await campaigns.publishTheme(SALE_THEME.themeKey, 1, null, BRAND_ID);
    report.saleTheme = 'created + published';
  } else {
    report.saleTheme = 'already exists';
  }

  // ---- Storewide Sale campaign (DRAFT — not published) --------------
  const existingCampaigns = (await campaigns.listCampaigns(BRAND_ID)).campaigns.map((c) => c.slug);
  if (!existingCampaigns.includes(SALE.slug)) {
    await campaigns.createCampaign(SALE, null, BRAND_ID);
    report.saleCampaign = 'created (DRAFT — publish from CMS when ready)';
  } else {
    report.saleCampaign = 'already exists — left untouched (edit dates/copy from CMS)';
  }

  // ---- Storewide Sale promotion (DRAFT — not active) -----------------
  const salePromos = await query('SELECT id, status FROM promotions WHERE name = ?', [SALE_PROMOTION.name]);
  if (!salePromos.length) {
    const p = await promotionService.create(SALE_PROMOTION);
    report.salePromotion = `created ${p.id} (DRAFT — activate from CMS when the discount % + dates are approved)`;
  } else {
    report.salePromotion = `already exists (${salePromos[0].id}, ${salePromos[0].status}) — left untouched`;
  }

  // ---- Diwali promotion (ACTIVE — future-dated, inert until the window) --
  const diwaliPromos = await query('SELECT id, status FROM promotions WHERE name = ?', [DIWALI_PROMOTION.name]);
  if (!diwaliPromos.length) {
    const p = await promotionService.create({ ...DIWALI_PROMOTION, status: 'ACTIVE' });
    report.diwaliPromotion = `created ${p.id} ACTIVE (future-dated — will not discount anything until ${DIWALI_STARTS})`;
  } else {
    report.diwaliPromotion = `already exists (${diwaliPromos[0].id}, ${diwaliPromos[0].status}) — left untouched`;
  }

  console.log('\nSale + Diwali campaigns\n');
  console.log(JSON.stringify(report, null, 2));
  console.log('\n--- Runbook ---');
  console.log('Storewide Sale (immediate revenue impact — needs a human decision):');
  console.log('  1. CMS -> Marketing -> Promotions & Coupons -> "Storewide Sale — 15% Off": review the');
  console.log('     15% figure and the 14-day window, then set status = ACTIVE.');
  console.log('  2. CMS -> Content -> Campaigns & Themes -> "Storewide Sale": review copy, then Publish.');
  console.log('  Both are independent switches — publishing the banner does not turn on the discount.');
  console.log('\nDiwali Festive Sale 2026 (26 Oct - 13 Nov):');
  console.log('  Both halves are already live and future-dated — nothing else to do unless the 20%');
  console.log('  figure or copy needs adjusting (CMS -> Promotions / database/seeds/content-campaigns.json, same as above).');
} finally {
  await pool.end();
}
