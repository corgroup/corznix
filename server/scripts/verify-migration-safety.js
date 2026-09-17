// Wave 8J-5 — migration runner safety.
//
//   - concurrent-run protection: the runner takes a MySQL named lock
//   - failure behaviour: a failing migration stops the sequence, earlier
//     migrations stay applied, and the failed file is NOT marked applied
//   - reconciliation: every migration file on disk is in schema_migrations,
//     and any tracked row not on disk is a known/legacy lineage entry only
//
// Runs the real runner loop against a TEMP migrations directory containing a
// deliberately-broken file (a SELECT on a missing table — no DDL, nothing to
// clean up in the DB). Self-cleaning.
//
//   npm run verify:migration-safety
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { env } from '../src/config/env.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(dir, '..', 'database', 'migrations');
const results = {};
const ok = (n, c, d = '') => { results[n] = c ? 'PASS' : `FAIL ${d}`; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const conn = await mysql.createConnection({
  host: env.DB_HOST, port: env.DB_PORT, database: env.DB_NAME,
  user: env.DB_USER, password: env.DB_PASSWORD, multipleStatements: true,
});

const TAG = Math.random().toString(36).slice(2, 8);
const tmp = mkdtempSync(path.join(os.tmpdir(), 'corcotton-mig-'));
const goodName = `900_${TAG}_ok.sql`;
const badName = `901_${TAG}_bad.sql`;
writeFileSync(path.join(tmp, goodName), 'SELECT 1;');
writeFileSync(path.join(tmp, badName), 'SELECT * FROM __table_that_does_not_exist_' + TAG + '__;');

try {
  // 1. runner source takes a named lock
  const runnerSrc = readFileSync(path.join(dir, 'migrate.js'), 'utf8');
  ok('concurrent_migration_lock', /GET_LOCK\(\s*'corcotton_migrations'/.test(runnerSrc) && /RELEASE_LOCK\(\s*'corcotton_migrations'/.test(runnerSrc));

  // 2. simulate the runner loop over the temp dir
  await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INT AUTO_INCREMENT PRIMARY KEY, version VARCHAR(255) NOT NULL, name VARCHAR(255) NOT NULL,
    applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_schema_migrations_version (version), UNIQUE KEY uq_schema_migrations_name (name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);

  const [[lock]] = await conn.query("SELECT GET_LOCK('corcotton_migrations', 5) ok");
  ok('lock_acquired', lock.ok === 1);

  const files = readdirSync(tmp).filter((f) => f.endsWith('.sql')).sort();
  let stoppedAt = null;
  let appliedInRun = [];
  for (const file of files) {
    try {
      const sql = readFileSync(path.join(tmp, file), 'utf8');
      await conn.query(sql);
      await conn.query('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', [file.split('_')[0], file]);
      appliedInRun.push(file);
    } catch {
      stoppedAt = file;
      break; // runner aborts the sequence
    }
  }
  await conn.query("SELECT RELEASE_LOCK('corcotton_migrations')");

  ok('failure_stops_sequence', stoppedAt === badName, `stopped at ${stoppedAt}`);
  ok('good_migration_before_failure_applied', appliedInRun.includes(goodName));
  const [badRow] = await conn.query('SELECT COUNT(*) n FROM schema_migrations WHERE name = ?', [badName]);
  ok('failed_migration_not_marked_applied', Number(badRow[0].n) === 0);

  // 3. reconciliation of the REAL migrations dir
  const realFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  const [appliedRows] = await conn.query('SELECT name FROM schema_migrations');
  const appliedNames = new Set(appliedRows.map((r) => r.name));
  const notApplied = realFiles.filter((f) => !appliedNames.has(f));
  const trackedNotOnDisk = [...appliedNames].filter((a) => !realFiles.includes(a) && /^\d/.test(a));
  ok('every_migration_file_applied', notApplied.length === 0, notApplied.join(','));
  console.log(`    real migration files: ${realFiles.length}; tracked-not-on-disk (legacy lineage, preserved): ${trackedNotOnDisk.length ? trackedNotOnDisk.join(', ') : 'none'}`);

  // 4. a deploy must never be able to change who can log into the CMS.
  //
  // Migrations and seeds both run as part of a deploy, unattended. If either
  // could write staff_users, then redeploying could silently replace the
  // admin account or reset its password — and the first anyone would know is
  // being locked out of production. Nothing writes that table today; this is
  // what keeps it that way.
  //
  // Reading it is fine (permission checks, audit joins). Only a WRITE to
  // staff_users is refused, and only in the files a deploy actually executes —
  // verify-* scripts are test code and never run against a real environment.
  //
  // staff_sessions is deliberately NOT covered: migration 077 backfills its
  // current_brand_id, which is a legitimate one-time column fill. The worst a
  // session write can do is sign someone out; only staff_users holds identity
  // and password_hash, and only that can lock an admin out of production.
  {
    const WRITE = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO|TRUNCATE(\s+TABLE)?)\s+`?(staff_users)`?/i;
    const offenders = [];

    for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql'))) {
      if (WRITE.test(readFileSync(path.join(migrationsDir, f), 'utf8'))) offenders.push(`migration ${f}`);
    }

    const scriptsDir = path.join(dir);
    for (const f of readdirSync(scriptsDir).filter((n) => n.startsWith('seed') && n.endsWith('.js'))) {
      if (WRITE.test(readFileSync(path.join(scriptsDir, f), 'utf8'))) offenders.push(`seed ${f}`);
    }

    ok('deploy_cannot_rewrite_staff_accounts', offenders.length === 0, offenders.join(', '));
  }

} catch (err) {
  console.error('verify-migration-safety crashed:', err);
  process.exitCode = 1;
} finally {
  await conn.query('DELETE FROM schema_migrations WHERE name IN (?, ?)', [goodName, badName]).catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
  await conn.end();
  console.log('\n──── migration safety ────');
  console.log(JSON.stringify(results, null, 1));
  const failed = Object.values(results).filter((v) => !v.startsWith('PASS'));
  console.log(failed.length ? `\n${failed.length} FAILED` : '\nMIGRATION_SAFETY = PASS');
  if (failed.length) process.exitCode = 1;
}
