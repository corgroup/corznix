// CI verification runner — executes the `verify:*` suite against a FRESH
// migrated + seeded database and reports a summary.
//
// Three tiers:
//   SKIP     — needs a live HTTP server this job does not run; not executed.
//   ADVISORY — needs order/checkout fixtures that `npm run seed` does not
//              create yet, or is a characterization baseline tied to a
//              hand-built dev DB. Run + reported, but does NOT fail the job.
//   (rest)   — must pass. A failure here fails the job.
//
// Override:
//   CI_ADVISORY="verify:a,verify:b"  replaces the ADVISORY list
//   CI_SKIP="verify:a,verify:b"      replaces the SKIP list
//
// The ADVISORY tier is technical debt: the verify suite evolved against a
// live dev database + running server. The order-fixture half of that is now
// built (`seed:orders`, run by the CI seed step); the remaining entries need
// either an in-CI HTTP server or their own fixture, and each should leave this
// list only once it has been shown to pass on a FRESH migrated+seeded database
// rather than on someone's accumulated dev data.
//
//   node scripts/ci-verify.mjs
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const serverDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(serverDir, 'package.json'), 'utf8'));

// Need a running HTTP server (make fetch() calls to a live origin).
const DEFAULT_SKIP = [
  'verify:cart',
  'verify:checkout',
  'verify:checkout:reallocation',
  'verify:commerce:reconciliation',
  'verify:hardening',
  'verify:inventory',
  // Makes real outbound requests to the media provider — an operator tool,
  // not part of the offline suite.
  'verify:media-integrity',
  // Same: a live preflight against the WhatsApp provider. Sends nothing, but
  // it does leave the machine, so it is run by an operator, not by CI.
  'verify:whatsapp-otp',
];

// Need seeded orders/fulfilments (seed.js creates catalog only, no orders) or
// are dev-DB characterization baselines. Run + reported, non-blocking.
const DEFAULT_ADVISORY = [
  // `verify:fulfillment` and `verify:fulfillment-ops` used to live here. Both
  // failed only for want of an order fixture, which `seed:orders` now builds
  // and the CI seed step runs, so they are required.
  //
  // Twelve more left in the same pass. Eight were failing on every run and
  // nothing could see it — the tier reported them and moved on:
  //   logistics-webhooks / notification-triggers / order-cancellation /
  //   communications / order-tracking  — all wanted a PROCESSING order with a
  //     fulfilment and an un-booked shipment, which `seed:orders` now builds
  //     (plus an `estimatedDays` shipping snapshot for the tracking surface).
  //   admin-inventory  — borrowed whatever inventory row sat at 0/0 instead of
  //     creating its own, so a fresh database had nothing to borrow.
  //   catalog:baseline — `seed.js` wrote `products.category_id` but never the
  //     `product_categories` membership it is meant to mirror, so every seeded
  //     PDP had an empty `categories[]`.
  //   platform-ops     — a real defect, not a fixture gap: `providerConfigService`
  //     only refused an unconfigured provider on the disabled -> enabled edge,
  //     so enabling one that already defaulted to enabled was waved through.
  // The other four (order-cms, rto-inventory, company-governance,
  // same-style-exchange) were already green on CI's fresh database across
  // consecutive runs, which is the bar this file sets for leaving the tier.
  //
  // builds delivered-order fixtures + review eligibility; cross-contaminated
  // by other scripts' delivered orders in the shared sequential run. Stays
  // advisory because the ordering hazard is real and unfixed — not because it
  // is unproven.
  'verify:reviews',
];

const listEnv = (name, fallback) =>
  process.env[name] !== undefined
    ? process.env[name].split(',').map((s) => s.trim()).filter(Boolean)
    : fallback;

const skip = new Set(listEnv('CI_SKIP', DEFAULT_SKIP));
const advisory = new Set(listEnv('CI_ADVISORY', DEFAULT_ADVISORY));

const targets = Object.keys(pkg.scripts)
  .filter((n) => n.startsWith('verify:'))
  .filter((n) => !skip.has(n))
  .sort();

console.log(`running ${targets.length} verify:* scripts  (skipped ${skip.size}, advisory ${advisory.size})\n`);

const results = [];
for (const name of targets) {
  process.stdout.write(`▶ ${name} ... `);
  const started = Date.now();
  const run = spawnSync('npm', ['run', '--silent', name], {
    cwd: serverDir,
    encoding: 'utf8',
    timeout: 90 * 1000,
    shell: process.platform === 'win32',
  });
  const ms = Date.now() - started;
  const ok = run.status === 0;
  const adv = advisory.has(name);
  results.push({ name, ok, ms, adv, output: `${run.stdout || ''}${run.stderr || ''}` });
  console.log(ok ? `PASS (${ms}ms)` : adv ? `FAIL — advisory (${ms}ms)` : `FAIL (${ms}ms)`);
}

const hardFails = results.filter((r) => !r.ok && !r.adv);
const softFails = results.filter((r) => !r.ok && r.adv);

console.log('\n──────── summary ────────');
console.log(`passed:        ${results.filter((r) => r.ok).length}`);
console.log(`advisory-fail: ${softFails.length} (ignored)  — ${softFails.map((r) => r.name).join(', ') || 'none'}`);
console.log(`failed:        ${hardFails.length}`);

for (const r of [...softFails, ...hardFails]) {
  console.log(`\n═══ ${r.adv ? 'ADVISORY' : 'FAILED'}: ${r.name} ═══`);
  console.log(r.output.split('\n').slice(-30).join('\n'));
}

if (hardFails.length) {
  console.log(`\n${hardFails.length} required verify script(s) failed: ${hardFails.map((r) => r.name).join(', ')}`);
  process.exit(1);
}
console.log('\nall required verify scripts passed.');
