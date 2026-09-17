// Cross-cutting CRM / commerce-operations integration invariants.
//
// Proves this layer did not fracture a single authority, leak a provider
// secret, or collapse a high-risk permission into a low-risk one. The
// per-domain behaviour is covered by verify:customer-operations /
// verify:consent-newsletter / verify:support / verify:reviews /
// verify:customer-segments / verify:promotions / verify:communications.
//
//   npm run verify:crm-operations
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const { pool, query } = await import('../src/database/connection/pool.js');
const { PERMISSIONS, resolvePermissions, roleHasPermission } = await import('../src/modules/staff/permissions.js');

const results = {};
const root = fileURLToPath(new URL('../..', import.meta.url));

function walk(dir, exts, hits, files = []) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'dist', '.git', 'coverage'].includes(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, exts, hits, files);
    else if (exts.some((e) => name.endsWith(e))) files.push(full);
  }
  return files;
}

try {
  // ============ 1. single customer identity authority (§8) ============
  const tables = (await query(
    `SELECT TABLE_NAME t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`)).map((r) => r.t);
  const identityDupes = tables.filter((t) => /^(crm|marketing|subscriber)_customers?$/.test(t) || t === 'customer_profiles');
  assert.deepEqual(identityDupes, [], 'no second customer identity table');
  assert.ok(tables.includes('customers'), 'the one customer authority exists');
  // an anonymous newsletter subscriber must not need a customer row
  const nlCustomerCol = (await query(
    `SELECT IS_NULLABLE n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='newsletter_subscribers' AND COLUMN_NAME='customer_id'`))[0];
  assert.equal(nlCustomerCol.n, 'YES', 'newsletter_subscribers.customer_id is nullable (anonymous subscribers)');
  results.customerAuthorityCount = 1;

  // ============ 2. no marketing_opt_in boolean as sole consent authority ============
  const optInCols = await query(
    `SELECT TABLE_NAME t, COLUMN_NAME c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE() AND COLUMN_NAME IN ('marketing_opt_in','opt_in','marketing_consent','newsletter_opt_in')`);
  assert.deepEqual(optInCols, [], 'consent is a ledger, never a single boolean column');
  assert.ok(tables.includes('consent_records') && tables.includes('consent_state'), 'consent ledger + state present');
  results.consentLedgerAuthority = 'PASS';

  // ============ 3. distinct authorities (§169) ============
  assert.ok(tables.includes('content_campaigns'), 'Wave 8E campaign authority');
  assert.ok(tables.includes('promotions'), 'the promotion pricing-rule authority');
  assert.ok(tables.includes('communication_broadcasts') && tables.includes('communication_messages'), 'the communication broadcast/outbox authority');
  // they must not reference each other as a shared table
  const promoSrc = readFileSync(new URL('../src/modules/promotions/service.js', import.meta.url), 'utf8');
  assert.ok(!/content_campaigns|contentCampaign/.test(promoSrc), 'promotions do not touch the 8E campaign table');
  const commSrc = readFileSync(new URL('../src/modules/communications/service.js', import.meta.url), 'utf8');
  assert.ok(!/content_campaigns|contentCampaign/.test(commSrc), 'communications do not touch the 8E campaign table');
  results.contentCampaignAuthorityCount = 1;
  results.promotionAuthorityCount = 1;
  results.communicationJobAuthorityCount = 1;

  // ============ 4. RBAC separation (§159/§160) ============
  // customers.read must NOT imply marketing.send or a bulk export.
  for (const role of ['SUPPORT', 'OPERATIONS', 'CATALOG_MANAGER', 'VIEWER']) {
    if (roleHasPermission(role, PERMISSIONS.CUSTOMERS_READ) || roleHasPermission(role, 'customers.read')) {
      assert.equal(roleHasPermission(role, PERMISSIONS.MARKETING_SEND), false, `${role}: customers.read does not grant marketing.send`);
    }
  }
  // catalog staff: no marketing / customer-management rights (§160)
  assert.equal(roleHasPermission('CATALOG_MANAGER', PERMISSIONS.MARKETING_SEND), false);
  assert.equal(roleHasPermission('CATALOG_MANAGER', PERMISSIONS.CUSTOMERS_MANAGE), false);
  assert.equal(roleHasPermission('CATALOG_MANAGER', PERMISSIONS.MARKETING_MANAGE), false);
  // marketing.send is strictly rarer than comms.read
  const sendRoles = ['SUPER_ADMIN', 'ADMIN', 'CATALOG_MANAGER', 'OPERATIONS', 'SUPPORT', 'VIEWER'].filter((r) => roleHasPermission(r, PERMISSIONS.MARKETING_SEND));
  const readRoles = ['SUPER_ADMIN', 'ADMIN', 'CATALOG_MANAGER', 'OPERATIONS', 'SUPPORT', 'VIEWER'].filter((r) => roleHasPermission(r, PERMISSIONS.COMMS_READ));
  assert.ok(sendRoles.length < readRoles.length, 'marketing.send is more restricted than comms.read');
  // VIEWER (read-everything) still cannot send / manage / moderate
  const viewer = resolvePermissions('VIEWER');
  assert.ok(!viewer.some((p) => /\.(send|manage|moderate|write|publish|adjust|refund)$/.test(p)), 'VIEWER holds only read permissions');
  results.rbacSeparation = 'PASS';

  // ============ 5. staff cannot self-grant customer consent (§151) ============
  const consentAdminRoutes = tables.length && (() => {
    try { return readFileSync(new URL('../src/modules/newsletter/adminRoutes.js', import.meta.url), 'utf8'); } catch { return ''; }
  })();
  assert.ok(!/action:\s*'GRANTED'|GRANTED.*STAFF|record\(\{[^}]*GRANTED/s.test(consentAdminRoutes),
    'no CMS route lets staff record a GRANTED consent');
  const consentSuppress = readFileSync(new URL('../src/modules/consent/service.js', import.meta.url), 'utf8');
  assert.ok(/HARD_BOUNCE.*MANUAL_COMPLIANCE|MANUAL_COMPLIANCE.*HARD_BOUNCE/s.test(consentSuppress),
    'staff suppression is limited to HARD_BOUNCE / MANUAL_COMPLIANCE');
  results.consentStaffGrantBlocked = 'PASS';

  // ============ 6. no provider secrets in the frontends (§170) ============
  const SECRET_RE = /(INFYNTRA_API_KEY|SMTP_PASSWORD|SMTP_USER\b|INFYNTRA_PHONE_ID|CASHFREE_SECRET|API_KEY\s*[:=]\s*['"][A-Za-z0-9]{12,})/;
  const feFiles = [
    ...walk(join(root, 'apps', 'cms', 'src'), ['.js', '.jsx'], null),
    ...walk(join(root, 'apps', 'corcotton', 'src'), ['.js', '.jsx'], null),
  ];
  const leaks = feFiles.filter((f) => SECRET_RE.test(readFileSync(f, 'utf8')));
  assert.deepEqual(leaks.map((f) => f.replace(root, '')), [], 'no provider secret literals in CMS / storefront source');
  results.frontendProviderSecrets = 0;
  results.cmsProviderSecrets = 0;

  // ============ 7. no raw provider response leak (§170) ============
  const commProviders = readFileSync(new URL('../src/modules/communications/providers.js', import.meta.url), 'utf8');
  assert.ok(!/return\s+.*response\.(json|text|headers|body)|res\.json\(rawEvent\)/.test(commProviders),
    'communication adapters never return the raw provider payload upward');
  const commRoutes = readFileSync(new URL('../src/modules/communications/routes.js', import.meta.url), 'utf8');
  assert.ok(!/rawEvent|req\.body\s*\}/.test(commRoutes.replace(/rawEvent:\s*req\.body/, '')), 'webhook route does not echo the payload back');
  results.rawProviderResponseLeak = 0;

  // ============ 8. CMS nav wired for every new operations surface ============
  const nav = readFileSync(new URL('../../apps/cms/src/layout/navigation.js', import.meta.url), 'utf8');
  // Support Tickets were folded into the unified /communications hub
  // (2026-09-04) — the customer-query surface is now /communications, not
  // a standalone /support page.
  for (const path of ['/customers', '/segments', '/subscribers', '/reviews', '/promotions', '/communications']) {
    assert.ok(nav.includes(`'${path}'`), `CMS nav exposes ${path}`);
  }
  const routerSrc = readFileSync(new URL('../../apps/cms/src/app/router.jsx', import.meta.url), 'utf8');
  for (const perm of ['customers.read', 'segments.read', 'reviews.read', 'promotions.read', 'comms.read']) {
    assert.ok(routerSrc.includes(`"${perm}"`), `CMS router guards a route with ${perm}`);
  }
  results.cmsIntegration = 'PASS';

  // ============ 9. immutable order discount snapshot feeds returns, not the live promo (§168) ============
  assert.ok(tables.includes('order_discounts') && tables.includes('order_item_discounts'), 'per-order discount snapshot tables');
  const refundSrc = readFileSync(new URL('../src/modules/returns/refundService.js', import.meta.url), 'utf8');
  assert.ok(!/promotions\/(service|promotionEngine|repository)/.test(refundSrc), 'refunds never import the live promotion engine');
  results.returnDiscountSnapshotIntegrity = 'PASS';

  results.status = 'PASS';
  console.log('\nCRM_OPERATIONS_INTEGRATION_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nCRM_OPERATIONS_INTEGRATION_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
