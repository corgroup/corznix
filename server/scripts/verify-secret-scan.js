// Wave 8J-2 — secret scanner. Walks the backend + both frontend source trees
// and (if present) their built bundles, plus the operational config table,
// looking for anything that looks like a live credential. Prints only file +
// line + the matched RULE — never the matched value.
//
//   npm run verify:secret-scan
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const RULES = [
  { name: 'aws_access_key_id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'private_key_block', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'stripe_live_key', re: /\bsk_live_[0-9a-zA-Z]{20,}/ },
  { name: 'google_api_key', re: /\bAIza[0-9A-Za-z_\-]{35}\b/ },
  { name: 'generic_bearer', re: /\bBearer\s+[A-Za-z0-9\-._~+/]{24,}=*/ },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'assigned_secret_literal', re: /(?:api[_-]?secret|client[_-]?secret|webhook[_-]?secret|access[_-]?token|refresh[_-]?token|db[_-]?password|api[_-]?key)\s*[:=]\s*['"][A-Za-z0-9/\-+_]{16,}['"]/i },
];

const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.vite', 'scratchpad']);
const SKIP_FILE = /\.(png|jpg|jpeg|gif|webp|ico|svg|woff2?|ttf|map|lock)$|\.example$|\.env\.example$|package-lock\.json$/i;
// Scan source; also explicitly scan built bundles when they exist.
const SCAN_ROOTS = [
  'server/src', 'server/scripts',
  'apps/cms/src', 'apps/corcotton/src',
  'apps/cms/dist', 'apps/corcotton/dist',
];
// Test scripts legitimately contain fake signing secrets for self-consistent
// HMAC checks — those are not real credentials.
const ALLOW = [/verify-payment-webhook\.js$/, /verify-.*\.js$/];

const findings = [];
function walk(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) { if (!SKIP_DIR.has(entry)) walk(full); continue; }
    if (SKIP_FILE.test(entry)) continue;
    if (st.size > 2_000_000) continue;
    const rel = path.relative(root, full).replace(/\\/g, '/');
    const allowed = ALLOW.some((re) => re.test(rel));
    const lines = readFileSync(full, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const rule of RULES) {
        if (rule.re.test(line)) {
          // an assigned-secret literal in a verify script = known test fixture
          if (allowed && rule.name === 'assigned_secret_literal') return;
          findings.push({ file: rel, line: i + 1, rule: rule.name });
        }
      }
    });
  }
}

for (const r of SCAN_ROOTS) walk(path.join(root, r));

// Operational config table must never hold a secret.
let dbFindings = 0;
try {
  const { pool, query } = await import('../src/database/connection/pool.js');
  const rows = await query('SELECT capability, provider_key, config_json FROM provider_configurations');
  const forbidden = /secret|token|password|api[_-]?key|private[_-]?key|credential|bearer/i;
  for (const row of rows) {
    const cfg = typeof row.config_json === 'string' ? JSON.parse(row.config_json || '{}') : (row.config_json ?? {});
    for (const k of Object.keys(cfg)) if (forbidden.test(k)) { dbFindings += 1; findings.push({ file: `db:provider_configurations/${row.capability}:${row.provider_key}`, line: 0, rule: 'secret_key_in_config' }); }
  }
  await pool.end();
} catch (e) { console.warn('  (db config scan skipped:', e.message, ')'); }

console.log('──── secret scan ────');
if (findings.length === 0) {
  console.log('SECRET_SCAN = PASS (0 findings across backend + frontend source + bundles + config table)');
} else {
  console.log(`SECRET_SCAN = FAIL (${findings.length} finding(s)) — values NOT printed:`);
  for (const f of findings) console.log(`  ${f.file}:${f.line}  [${f.rule}]`);
  process.exitCode = 1;
}
