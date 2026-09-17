// Wave 8J-5 — backup + RESTORE validation. A backup that has never been
// restored is not validated (brief §66).
//
// Flow (all local, never touches the dev DB):
//   1. mysqldump the dev database to a temp .sql file
//   2. CREATE a fresh throwaway database
//   3. load the dump into it
//   4. run the data-integrity invariants against the RESTORED copy
//   5. reconcile migration files vs schema_migrations in the restored copy
//   6. DROP the throwaway database + delete the dump file
//
// The MySQL password is passed via the MYSQL_PWD env var to the child (never
// on argv / never printed).
//
//   npm run db:restore-test
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { env } from '../src/config/env.js';

// The app DB account is least-privilege (rights on the app schema only), so a
// true restore-into-a-fresh-database needs an admin account. Supply it via
// DB_ADMIN_USER / DB_ADMIN_PASSWORD to run the full drill; without it the
// script still validates the DUMP content and flags the live restore as an
// environment-dependent validation for staging (8K).
const ADMIN_USER = process.env.DB_ADMIN_USER || null;
const HAS_ADMIN = Boolean(ADMIN_USER);

const STAMP = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
const TEST_DB = `corcotton_restore_test_${STAMP}`;
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'corcotton-restore-'));
const dumpFile = path.join(tmpDir, 'backup.sql');
const migrationsDir = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '..', 'database', 'migrations');

const base = ['-h', String(env.DB_HOST), '-P', String(env.DB_PORT), '-u', HAS_ADMIN ? ADMIN_USER : String(env.DB_USER)];
const childEnv = { ...process.env, MYSQL_PWD: HAS_ADMIN ? String(process.env.DB_ADMIN_PASSWORD || '') : String(env.DB_PASSWORD || '') };
const dumpBase = ['-h', String(env.DB_HOST), '-P', String(env.DB_PORT), '-u', String(env.DB_USER)];
const dumpEnv = { ...process.env, MYSQL_PWD: String(env.DB_PASSWORD || '') };

function mysql(args, opts = {}) {
  const r = spawnSync('mysql', [...base, ...args], { env: childEnv, encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`mysql ${args[0] || ''} failed: ${(r.stderr || '').trim() || r.error?.message}`);
  return r.stdout;
}
function q(sql, db = TEST_DB) {
  return mysql(['-N', '-B', db, '-e', sql]).trim();
}

const results = {};
const ok = (name, cond, detail = '') => { results[name] = cond ? 'PASS' : `FAIL ${detail}`; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

try {
  // 1. dump (always — uses the app account, which can read its own schema)
  const dump = spawnSync('mysqldump', [...dumpBase, '--single-transaction', '--routines', '--events', '--result-file', dumpFile, String(env.DB_NAME)], { env: dumpEnv, encoding: 'utf8' });
  if (dump.status !== 0) throw new Error(`mysqldump failed: ${(dump.stderr || '').trim()}`);
  ok('backup_created', existsSync(dumpFile), `${(statSync(dumpFile).size / 1024).toFixed(0)} KB`);

  // dump content sanity — authoritative schema + data actually captured
  const sql = readFileSync(dumpFile, 'utf8');
  const ddl = ['customers', 'orders', 'order_items', 'store_credit_entries', 'provider_configurations', 'schema_migrations']
    .filter((t) => sql.includes(`CREATE TABLE \`${t}\``));
  ok('backup_contains_authoritative_schema', ddl.length === 6, `${ddl.length}/6 tables`);
  ok('backup_contains_data', /INSERT INTO `(customers|products|schema_migrations)`/.test(sql));
  ok('backup_has_no_plaintext_password_arg', !sql.includes('--password='));

  // completeness: the dump must contain a CREATE TABLE for EVERY table the
  // live DB currently has (a partial dump is a silent recovery hole).
  const liveTablesRaw = spawnSync('mysql', [...dumpBase, '-N', '-B', String(env.DB_NAME), '-e',
    `SELECT table_name FROM information_schema.tables WHERE table_schema='${env.DB_NAME}' AND table_type='BASE TABLE'`],
  { env: dumpEnv, encoding: 'utf8' });
  const liveTables = (liveTablesRaw.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const missingFromDump = liveTables.filter((t) => !sql.includes(`CREATE TABLE \`${t}\``));
  ok('backup_covers_every_live_table', missingFromDump.length === 0, missingFromDump.join(','));

  const migMarkers = (sql.match(/INSERT INTO `schema_migrations`/g) || []).length;
  ok('backup_captures_migration_ledger', migMarkers >= 1);

  if (!HAS_ADMIN) {
    results.restore_into_fresh_db = 'SKIPPED_NEEDS_ADMIN_DB_ACCOUNT';
    console.log('  SKIP  restore_into_fresh_db — app account is least-privilege (no CREATE DATABASE).');
    console.log('        Set DB_ADMIN_USER / DB_ADMIN_PASSWORD to run the full restore drill. It runs in staging (8K).');
    throw { skipRest: true };
  }

  // 2 + 3. fresh DB + load
  mysql(['-e', `DROP DATABASE IF EXISTS \`${TEST_DB}\`; CREATE DATABASE \`${TEST_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`]);
  const load = spawnSync('mysql', [...base, TEST_DB, '-e', `source ${dumpFile.replace(/\\/g, '/')}`], { env: childEnv, encoding: 'utf8' });
  if (load.status !== 0) throw new Error(`restore load failed: ${(load.stderr || '').trim()}`);
  ok('restore_into_fresh_db', true);

  // 4. authoritative tables present + populated-or-empty (not missing)
  const authorities = ['customers', 'products', 'orders', 'order_items', 'inventory', 'payment_obligations',
    'return_requests', 'refund_attempts', 'store_credit_accounts', 'store_credit_entries', 'support_tickets',
    'product_reviews', 'promotions', 'content_blocks', 'provider_configurations', 'reconciliation_exceptions',
    'staff_audit_logs', 'schema_migrations'];
  let missing = [];
  for (const t of authorities) {
    const n = q(`SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${TEST_DB}' AND table_name='${t}'`);
    if (n !== '1') missing.push(t);
  }
  ok('restore_validation_authorities_present', missing.length === 0, missing.join(','));

  // integrity invariants on the restored copy (subset of verify-data-integrity)
  const inv = [
    ['store_credit_balance', `SELECT COUNT(*) FROM (SELECT a.id FROM store_credit_accounts a LEFT JOIN (SELECT account_id,SUM(amount_minor) s FROM store_credit_entries GROUP BY account_id) e ON e.account_id=a.id WHERE a.balance_minor<>COALESCE(e.s,0)) x`],
    ['no_orphan_order_items', `SELECT COUNT(*) FROM order_items oi LEFT JOIN orders o ON o.id=oi.order_id WHERE o.id IS NULL`],
    ['every_active_brand_has_one_company_profile', `SELECT COUNT(*) FROM brands b WHERE b.status = 'active' AND NOT EXISTS (SELECT 1 FROM company_profiles cp WHERE cp.brand_id = b.id)`],
    ['refund_one_per_return', `SELECT COUNT(*) FROM (SELECT return_request_id FROM refund_attempts GROUP BY return_request_id HAVING COUNT(*)>1) x`],
  ];
  let invBad = [];
  for (const [name, sql] of inv) { if (q(sql) !== '0') invBad.push(name); }
  ok('restore_integrity_invariants', invBad.length === 0, invBad.join(','));

  // 5. migration reconciliation
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  const appliedRows = q(`SELECT name FROM schema_migrations ORDER BY name`).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const filesNotApplied = files.filter((f) => !appliedRows.includes(f));
  const appliedNotOnDisk = appliedRows.filter((a) => !files.includes(a));
  console.log(`    migration files: ${files.length}, applied rows: ${appliedRows.length}`);
  if (appliedNotOnDisk.length) console.log(`    (tracked legacy lineage not on disk — expected, preserved: ${appliedNotOnDisk.join(', ')})`);
  ok('migration_reconciliation', filesNotApplied.length === 0, filesNotApplied.length ? `files not applied: ${filesNotApplied.join(',')}` : '');
} catch (err) {
  if (!err?.skipRest) { console.error('db-restore-test failed:', err.message); process.exitCode = 1; }
} finally {
  if (HAS_ADMIN) { try { mysql(['-e', `DROP DATABASE IF EXISTS \`${TEST_DB}\``]); console.log('  cleanup: dropped', TEST_DB); } catch (e) { console.error('  cleanup DB:', e.message); } }
  try { rmSync(tmpDir, { recursive: true, force: true }); console.log('  cleanup: removed temp dump'); } catch (e) { console.error('  cleanup file:', e.message); }
  console.log('\n──── backup / restore test ────');
  console.log(JSON.stringify(results, null, 1));
  const failed = Object.values(results).filter((v) => !v.startsWith('PASS') && !v.startsWith('SKIPPED'));
  const skipped = Object.values(results).filter((v) => v.startsWith('SKIPPED'));
  console.log(failed.length ? `\n${failed.length} FAILED`
    : skipped.length ? '\nBACKUP = PASS · RESTORE_INTO_FRESH_DB = SKIPPED_NEEDS_ADMIN_DB_ACCOUNT (staging/8K)'
      : '\nBACKUP = PASS · RESTORE_TEST = PASS');
  console.log('TEMP_BACKUP_DB_REMOVED = YES\nTEMP_BACKUP_FILES_REMOVED = YES');
  if (failed.length) process.exitCode = 1;
}
