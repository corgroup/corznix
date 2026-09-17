// Repository naming verification.
//
// Long-lived identifiers must describe responsibility, not the implementation
// wave/phase they were built in. Planning/changelog PROSE (docs, code comments
// that narrate history) may keep "Wave N" references — this check targets
// concrete names and references only:
//
//   1. tracked file / directory names containing a wave/phase token
//   2. schema identifiers (CONSTRAINT / INDEX / KEY / TABLE names) in
//      server/database/migrations/*.sql containing a wave/phase token
//   3. wave/phase-labelled status tokens in server JS (e.g. WAVE_8A_x = PASS)
//   4. compact wave/phase tags in verification scripts (e.g. `w8b-`, `wave6c`)
//   5. references to server/scripts/*.js files that do not exist
//
// A small ALLOWLIST covers wave-named schema identifiers that are already
// scheduled for replacement by a specific upcoming migration. They are
// reported as tracked debt (WARN) and do not fail the check until their
// migration lands and removes them from the allowlist.
//
//   npm run verify:repository:naming
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const serverScriptsDir = path.join(__dirname);

// Wave-named schema identifiers that a named upcoming migration will remove.
// Format: identifier -> reason. Remove an entry once its migration lands.
const SCHEMA_IDENTIFIER_ALLOWLIST = new Map();

const WAVE_TOKEN = /(^|[^a-z])(wave|phase)[-_ ]?\d/i;
const SCHEMA_NAME = /\b(?:CONSTRAINT|(?:UNIQUE\s+)?(?:INDEX|KEY)|TABLE)\s+`?([A-Za-z0-9_]*(?:wave|phase)[A-Za-z0-9_]*)`?/gi;
const STATUS_TOKEN = /\b((?:WAVE|PHASE)_\d[A-Z0-9_]*)\s*=/g;
const COMPACT_TAG = /\b(w[0-9][a-f]|(?:wave|phase)[0-9])\b/gi;
const SCRIPT_REF = /scripts\/([A-Za-z0-9._-]+\.js)/g;

const failures = [];
const warnings = [];

// Tracked files plus not-yet-committed, non-ignored files — so a new migration
// or script is checked before it is staged.
const tracked = [...new Set(
  execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean),
)];

// `implementation/` is the phase-by-phase implementation-record tree: planning /
// changelog PROSE whose directory layout is deliberately keyed to the phase it
// documents (`implementation/phase-01b/…`). That is exactly the "prose may keep
// wave/phase references" carve-out — the ban is on long-lived CODE identifiers.
const PROSE_PHASE_TREES = ['implementation/'];

// 1. file / directory names
for (const file of tracked) {
  if (PROSE_PHASE_TREES.some((prefix) => file.startsWith(prefix))) continue;
  for (const segment of file.split('/')) {
    if (WAVE_TOKEN.test(segment)) {
      failures.push(`file/dir name carries a wave/phase token: ${file}`);
      break;
    }
  }
}

const serverJs = tracked.filter((f) => f.startsWith('server/') && f.endsWith('.js'));
const migrations = tracked
  .filter((f) => f.startsWith('server/database/migrations/') && f.endsWith('.sql'))
  .sort();
const migrationSql = new Map(migrations.map((f) => [f, readFileSync(path.join(repoRoot, f), 'utf8')]));

// Identifiers a later migration DROP CHECK / DROP INDEX / DROP CONSTRAINTs are
// gone from the live schema — their appearance in an earlier (immutable)
// migration's CREATE is history, not debt.
const RETIRED = /\bDROP\s+(?:CHECK|CONSTRAINT|(?:UNIQUE\s+)?(?:INDEX|KEY))\s+`?([A-Za-z0-9_]+)`?/gi;
const retired = new Set();
for (const sql of migrationSql.values()) {
  for (const match of sql.matchAll(RETIRED)) retired.add(match[1]);
}

// 2. schema identifiers in migrations
for (const [file, sql] of migrationSql) {
  for (const match of sql.matchAll(SCHEMA_NAME)) {
    const identifier = match[1];
    if (retired.has(identifier)) continue;
    if (SCHEMA_IDENTIFIER_ALLOWLIST.has(identifier)) {
      warnings.push(`${identifier} (${file}) — tracked debt: ${SCHEMA_IDENTIFIER_ALLOWLIST.get(identifier)}`);
    } else {
      failures.push(`schema identifier carries a wave/phase token: ${identifier} (${file})`);
    }
  }
}

// 3. wave/phase status tokens + 4. broken script references, in server JS
for (const file of serverJs) {
  if (file === 'server/scripts/verify-repository-naming.js') continue;
  const text = readFileSync(path.join(repoRoot, file), 'utf8');

  for (const match of text.matchAll(STATUS_TOKEN)) {
    failures.push(`wave/phase-labelled status token: ${match[1]} (${file})`);
  }

  if (file.startsWith('server/scripts/')) {
    for (const match of text.matchAll(COMPACT_TAG)) {
      failures.push(`compact wave/phase tag: ${match[1]} (${file})`);
    }
  }

  for (const match of text.matchAll(SCRIPT_REF)) {
    const referenced = match[1];
    if (!existsSync(path.join(serverScriptsDir, referenced))) {
      failures.push(`reference to a non-existent script: scripts/${referenced} (${file})`);
    }
  }
}

const results = {
  trackedFiles: tracked.length,
  serverJsScanned: serverJs.length,
  migrationsScanned: migrations.length,
  failures: failures.length,
  trackedNamingDebt: warnings.length,
};

for (const warning of warnings) console.log(`  WARN  ${warning}`);
for (const failure of failures) console.error(`  FAIL  ${failure}`);

if (failures.length) {
  console.error('\nREPOSITORY_NAMING_VERIFICATION = FAIL');
  console.error(JSON.stringify(results, null, 2));
  process.exitCode = 1;
} else {
  console.log('\nREPOSITORY_NAMING_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
}
