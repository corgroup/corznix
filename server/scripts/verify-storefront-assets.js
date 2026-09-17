// Storefront asset-ownership audit (Wave 8D asset cleanup).
//
// Asserts that no dynamic/business media (product / collection / banner /
// editorial video or image) is bundled in the storefront any more, and that
// every reference resolves. Static UI assets (SVG icon components, the logo
// SVG component, favicon) are allowed and expected to stay local.
//
// Requires:
//   BROKEN_IMAGE_IMPORTS = 0
//   BROKEN_VIDEO_IMPORTS = 0
//   BROKEN_ASSET_REFERENCES = 0
//   LOGO_SOURCE_COUNT = 1
//   BROKEN_LOGO_REFERENCES = 0
//   LOCAL_PRODUCT_MEDIA_AUTHORITY = 0
//   LOCAL_VIDEO_AUTHORITY = 0
//
//   npm run verify:storefront:assets
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', '..', 'apps', 'corcotton', 'src');
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'apps', 'corcotton', 'public');

const results = {};
const fail = [];
const check = (name, ok, detail) => {
  results[name] = ok ? 'PASS' : `FAIL${detail ? ` — ${detail}` : ''}`;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fail.push(name);
};

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else out.push(full);
  }
  return out;
}

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

const files = await walk(SRC);
const codeFiles = files.filter((f) => /\.(js|jsx|css)$/.test(f));

// ---- 1. no raster/video assets bundled under src -----------------------
const bundledMedia = files.filter((f) => /\.(png|jpe?g|webp|gif|avif|mp4|webm|mov)$/i.test(f));
check('NO_BUNDLED_DYNAMIC_MEDIA', bundledMedia.length === 0,
  bundledMedia.length ? bundledMedia.map((f) => path.relative(SRC, f)).join(', ') : null);
results.LOCAL_PRODUCT_MEDIA_AUTHORITY = bundledMedia.filter((f) => /\.(png|jpe?g|webp|gif|avif)$/i.test(f)).length;
results.LOCAL_VIDEO_AUTHORITY = bundledMedia.filter((f) => /\.(mp4|webm|mov)$/i.test(f)).length;

// ---- 2. import / url() / string references all resolve ---------------
const importRe = /(?:import\s+[^'"]*?from\s*|import\s*)['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|url\(\s*['"]?([^'")]+)['"]?\s*\)/g;
let brokenImage = 0;
let brokenVideo = 0;
let brokenOther = 0;
const broken = [];

for (const file of codeFiles) {
  const text = await readFile(file, 'utf8');
  let m;
  while ((m = importRe.exec(text))) {
    const spec = m[1] || m[2] || m[3];
    if (!spec) continue;
    if (!spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('@/')) continue; // bare pkg / alias handled by bundler
    const rel = spec.startsWith('@/') ? spec.slice(2) : spec;
    const base = spec.startsWith('@/') ? SRC : path.dirname(file);
    const target = path.resolve(base, rel);
    const candidates = [target, `${target}.js`, `${target}.jsx`, `${target}.ts`, `${target}.tsx`, path.join(target, 'index.js'), path.join(target, 'index.jsx')];
    let hit = false;
    for (const c of candidates) { if (await exists(c)) { hit = true; break; } }
    if (!hit) {
      broken.push(`${path.relative(SRC, file)} -> ${spec}`);
      if (/\.(png|jpe?g|webp|gif|avif)$/i.test(spec)) brokenImage += 1;
      else if (/\.(mp4|webm|mov)$/i.test(spec)) brokenVideo += 1;
      else brokenOther += 1;
    }
  }
}

results.BROKEN_IMAGE_IMPORTS = brokenImage;
results.BROKEN_VIDEO_IMPORTS = brokenVideo;
results.BROKEN_ASSET_REFERENCES = brokenImage + brokenVideo + brokenOther;
check('BROKEN_IMAGE_IMPORTS_ZERO', brokenImage === 0, brokenImage ? broken.join('; ') : null);
check('BROKEN_VIDEO_IMPORTS_ZERO', brokenVideo === 0, brokenVideo ? broken.join('; ') : null);
check('BROKEN_ASSET_REFERENCES_ZERO', results.BROKEN_ASSET_REFERENCES === 0, results.BROKEN_ASSET_REFERENCES ? broken.join('; ') : null);

// ---- 3. logo — single canonical source, all refs resolve ------------
const logoFiles = files.filter((f) => /(^|[/\\])Logo\.(jsx?|svg)$/.test(f));
results.LOGO_SOURCE_COUNT = logoFiles.length;
check('LOGO_SOURCE_COUNT_IS_1', logoFiles.length === 1,
  logoFiles.map((f) => path.relative(SRC, f)).join(', '));
const canonicalLogo = logoFiles[0] && path.relative(SRC, logoFiles[0]).replace(/\\/g, '/');
check('LOGO_IN_ICONS_DIR', canonicalLogo === 'assets/icons/Logo.jsx', canonicalLogo);

let brokenLogoRefs = 0;
for (const file of codeFiles) {
  const text = await readFile(file, 'utf8');
  // any import that pulls Logo from a non-canonical path
  const badPath = /from\s+['"][^'"]*\/assets\/Logo['"]/.test(text) || /from\s+['"]\.\.?\/assets\/Logo['"]/.test(text);
  if (badPath) brokenLogoRefs += 1;
}
results.BROKEN_LOGO_REFERENCES = brokenLogoRefs;
check('BROKEN_LOGO_REFERENCES_ZERO', brokenLogoRefs === 0);

// ---- 4. favicon still local (allowed) -----------------------------
check('FAVICON_LOCAL', await exists(path.join(PUBLIC_DIR, 'favicon.svg')));

console.log(`\nSTOREFRONT_ASSET_AUDIT = ${fail.length ? 'FAIL' : 'PASS'}`);
console.log(JSON.stringify(results, null, 2));
if (fail.length) process.exitCode = 1;
