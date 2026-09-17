// Which products cannot appear on a GST invoice yet.
//
// invoiceService.issueForOrder refuses to write an invoice unless EVERY product
// on the order resolves to an effective tax profile (taxResolution.js): a
// missing one returns { blocked: true, taxStatus: 'INCOMPLETE' } and no invoice
// row is created at all. That is the right call — a GST invoice carrying a
// guessed HSN is worse than no invoice — but it means one unmapped product
// silently blocks the invoice for every order containing it, and the customer
// is told only "Your invoice is being prepared."
//
// GST itself is already sourced from the authoritative tax_profiles rows and is
// nowhere hard-coded; what is missing is the product -> profile mapping. That
// mapping is a tax decision (HSN/SAC code and rate per product), so this script
// reports what needs deciding and never invents a value.
//
// Read-only.
//
//   npm run report:tax-coverage
import { pool, query } from '../src/database/connection/pool.js';

const profiles = await query(
  `SELECT id, hsn_sac, gst_rate_bps, taxability, status, effective_from, effective_to
     FROM tax_profiles ORDER BY hsn_sac`);

const products = await query(
  `SELECT p.id, p.name, p.status,
          tp.id AS profile_id, tp.hsn_sac, tp.gst_rate_bps, tp.status AS profile_status,
          tp.effective_from, tp.effective_to
     FROM products p
     LEFT JOIN product_tax_profiles ptp ON ptp.product_id = p.id
     LEFT JOIN tax_profiles tp ON tp.id = ptp.tax_profile_id
    WHERE p.status = 'ACTIVE'
    ORDER BY p.name`);

const today = new Date().toISOString().slice(0, 10);
const asDate = (v) => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

const rows = products.map((p) => {
  let state = 'ok';
  if (!p.profile_id) state = 'NO_TAX_PROFILE';
  else {
    const from = asDate(p.effective_from);
    const to = asDate(p.effective_to);
    if (p.profile_status !== 'ACTIVE' || !(from <= today && (to == null || to >= today))) state = 'TAX_PROFILE_NOT_EFFECTIVE';
  }
  return {
    product: p.name,
    hsn: p.hsn_sac || '-',
    gst: p.gst_rate_bps == null ? '-' : `${Number(p.gst_rate_bps) / 100}%`,
    state,
  };
});

const blocked = rows.filter((r) => r.state !== 'ok');

// Orders already stuck behind it — the customer-visible cost.
const stuck = await query(
  `SELECT COUNT(DISTINCT o.id) AS n
     FROM orders o
     JOIN order_items oi ON oi.order_id = o.id
     LEFT JOIN product_tax_profiles ptp ON ptp.product_id = oi.product_id
    WHERE o.order_status NOT IN ('CANCELLED')
      AND ptp.product_id IS NULL`);

console.log('');
console.log(`===== TAX PROFILES (${profiles.length}) =====`);
console.table(profiles.map((t) => ({
  hsn: t.hsn_sac, gst: `${Number(t.gst_rate_bps) / 100}%`, taxability: t.taxability,
  status: t.status, from: asDate(t.effective_from), to: asDate(t.effective_to) || 'open',
})));

console.log(`===== ACTIVE PRODUCTS (${rows.length}) =====`);
console.table(rows);

console.log('');
if (blocked.length) {
  console.log(`${blocked.length} of ${rows.length} active product(s) cannot appear on a GST invoice:`);
  for (const r of blocked) console.log(`  ${r.product} — ${r.state}`);
  console.log('');
  console.log(`Orders currently unable to produce an invoice because of this: ${Number(stuck[0].n)}`);
  console.log('');
  console.log('Fix: in the CMS, assign a tax profile (HSN/SAC + GST rate) to each product');
  console.log('above. The rate and HSN are a tax decision, so nothing here guesses them.');
} else {
  console.log(`All ${rows.length} active products resolve to an effective tax profile.`);
}
console.log('');

await pool.end();
process.exit(0);
