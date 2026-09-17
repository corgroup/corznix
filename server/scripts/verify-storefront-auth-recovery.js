// Every authenticated storefront request must go through apiClient.
//
// apiClient owns the 401 -> refresh -> retry recovery. The access-token cookie's
// maxAge equals the JWT TTL, so after ~15 minutes the browser deletes it and
// the next request carries no token at all: the server answers 401
// AUTH_REQUIRED, and apiClient transparently refreshes and retries. Any code
// that calls fetch() directly opts out of that and fails instead.
//
// This is not hypothetical. InvoiceButton did exactly that, so Download Invoice
// answered "Authentication required." for any signed-in customer whose access
// token had aged out — on a page where every other request recovered silently.
// The customer's session was fine; only that one button bypassed the recovery.
//
// Requires:
//   BARE_FETCH_OUTSIDE_API_CLIENT = 0
//   DOWNLOAD_HELPER_SHARES_RECOVERY = PASS
//   INVOICE_BUTTON_USES_HELPER      = PASS
//
//   npm run verify:storefront:auth-recovery
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..', '..', 'apps', 'corcotton', 'src');
const API_CLIENT = path.join(APP, 'services', 'apiClient.js');

const results = {};
const failures = [];
const check = (name, ok, detail) => {
  results[name] = ok ? `PASS${detail ? ` (${detail})` : ''}` : `FAIL${detail ? ` — ${detail}` : ''}`;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (/\.(js|jsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = await walk(APP);

// 1. No bare fetch() anywhere but apiClient itself. Comments and strings are
//    stripped first so a fetch() named in a note does not count.
const offenders = [];
for (const file of files) {
  if (path.resolve(file) === path.resolve(API_CLIENT)) continue;
  const code = (await readFile(file, 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  if (/(?<![.\w])fetch\s*\(/.test(code)) offenders.push(path.relative(APP, file));
}
check('BARE_FETCH_OUTSIDE_API_CLIENT', offenders.length === 0,
  offenders.length ? `${offenders.length}: ${offenders.join(', ')}` : `${files.length} files scanned`);

// 2. The binary-download helper must share the same recovery, not just exist.
//    A downloadBlob that forgot to refresh would reintroduce the bug while
//    looking like the fix.
const clientSrc = await readFile(API_CLIENT, 'utf8');
const helper = /export async function downloadBlob[\s\S]*?\n}/.exec(clientSrc)?.[0] || '';
const helperChecks = {
  'refreshSessionOnce()': helper.includes('refreshSessionOnce('),
  'RETRYABLE_AUTH_CODES': helper.includes('RETRYABLE_AUTH_CODES'),
  'isSessionEndedCode()': helper.includes('isSessionEndedCode('),
  'announceSessionEnded()': helper.includes('announceSessionEnded('),
};
const missing = Object.entries(helperChecks).filter(([, present]) => !present).map(([k]) => k);
check('DOWNLOAD_HELPER_SHARES_RECOVERY', helper !== '' && missing.length === 0,
  helper === '' ? 'downloadBlob not found in apiClient' : missing.length ? `missing: ${missing.join(', ')}` : 'refresh + retry + session-ended');

// 3. The invoice button must actually use it.
const buttonSrc = await readFile(path.join(APP, 'components', 'account', 'InvoiceButton.jsx'), 'utf8');
check('INVOICE_BUTTON_USES_HELPER',
  buttonSrc.includes('downloadBlob') && !/(?<![.\w])fetch\s*\(/.test(buttonSrc),
  'downloadBlob, no bare fetch');

console.log('');
console.log(JSON.stringify(results, null, 2));
console.log('');
console.log(`STOREFRONT_AUTH_RECOVERY = ${failures.length ? 'FAIL' : 'PASS'}`);
process.exit(failures.length ? 1 : 0);
