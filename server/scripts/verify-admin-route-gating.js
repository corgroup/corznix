// Every admin route must carry a permission gate.
//
// The whole /admin router sits behind `authenticateStaff`, but that only
// establishes that the caller is *some* staff member. A route that carries no
// `requireStaffPermission(...)` of its own is reachable by every staff account
// regardless of role — a warehouse packer could call it as readily as a
// director. This codebase has already had one failure of exactly that shape
// (the warehouse-scope bypass that left the Orders CMS unfiltered), so the
// property is worth enforcing mechanically rather than by review.
//
// Static analysis on purpose: probing routes at runtime can only cover the
// routes someone remembered to probe, whereas this fails the moment a new
// ungated route is added.
//
// Read-only: touches no database and starts no server.
//
//   npm run verify:admin-route-gating --workspace=server
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const srcDir = path.join(serverDir, 'src');

// Middleware that constitutes a gate. `requireResourceBrand` is included
// because it is an authorisation check too — it refuses a resource belonging
// to another company — but it is never sufficient alone, which is asserted
// separately below.
const PERMISSION_GATES = ['requireStaffPermission', 'requireSuperAdmin', 'requirePermission'];
const BRAND_GATES = ['requireResourceBrand'];

// Routes deliberately open to any authenticated staff member. Each one was
// read and its own authorisation confirmed — an entry here is a claim that the
// route needs no permission, so it carries the reason it does not.
const INTENTIONALLY_UNGATED = new Map([
  ['POST /auth/login', 'pre-authentication'],
  ['POST /auth/logout', 'ends the caller\'s own session'],
  ['POST /auth/change-password', 'the caller\'s own password; gated on the forced-change flag, not a permission'],
  ['GET /me', 'the caller\'s own identity and permission set — needed to render any CMS at all'],
  // Not a permission question but an access one, and it is checked:
  // staffAuthService.switchBrand refuses with BRAND_ACCESS_DENIED (403)
  // unless the target is in accessibleBrandsForStaff.
  ['PUT /session/brand', 'switches to a company the caller already has access to; verified in staffAuthService.switchBrand'],
  // Every staff member has their own notification feed. All four are scoped
  // by the caller's staff id and by warehouseScopeForStaff.
  ['GET /notifications', 'the caller\'s own notification feed'],
  ['GET /notifications/unread-count', 'the caller\'s own unread count'],
  ['POST /notifications/read', 'marks the caller\'s own rows read, visibility-filtered'],
  ['POST /notifications/read-all', 'marks the caller\'s own rows read, visibility-filtered'],
]);

/** Which route files are actually mounted under /admin. */
function adminRouteFiles() {
  const composition = readFileSync(path.join(srcDir, 'modules', 'staff', 'routes.js'), 'utf8');
  const files = new Set([path.join(srcDir, 'modules', 'staff', 'routes.js')]);
  const importRe = /import\s+(\w+)\s+from\s+'([^']+)'/g;
  const imported = new Map();
  let m = importRe.exec(composition);
  while (m) {
    imported.set(m[1], m[2]);
    m = importRe.exec(composition);
  }
  const useRe = /router\.use\((?:'[^']*',\s*)?(\w+)\)/g;
  let u = useRe.exec(composition);
  while (u) {
    const spec = imported.get(u[1]);
    if (spec && spec.startsWith('.')) {
      files.add(path.resolve(path.join(srcDir, 'modules', 'staff'), spec));
    }
    u = useRe.exec(composition);
  }
  return [...files];
}

/** const read = requireStaffPermission(...) — resolve local aliases to gates. */
function gateAliases(source) {
  const permission = new Set();
  const brand = new Set();
  const re = /(?:const|let)\s+(\w+)\s*=\s*(\w+)\s*\(/g;
  let m = re.exec(source);
  while (m) {
    const [, alias, factory] = m;
    if (PERMISSION_GATES.includes(factory)) permission.add(alias);
    if (BRAND_GATES.includes(factory)) brand.add(alias);
    m = re.exec(source);
  }
  return { permission, brand };
}

/** Split an argument list on its top-level commas, ignoring nesting and strings. */
function splitArgs(body) {
  const args = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quote) {
      if (ch === quote && body[i - 1] !== '\\') quote = null;
// eslint-disable-next-line no-continue
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) { args.push(body.slice(start, i).trim()); start = i + 1; }
  }
  args.push(body.slice(start).trim());
  return args;
}

/**
 * Extract each route declaration and its argument list. Balanced-paren scan
 * rather than a line regex, because plenty of these span several lines with
 * inline handlers.
 *
 * The arguments are kept separate rather than searched as one blob of text:
 * doing the latter matched the alias `reports` against the URL path
 * `/reports/meta` (slashes are word boundaries), which made an ungated route
 * look gated. Each argument is now tested for being a gate, not for
 * containing one.
 */
function routes(source) {
  const found = [];
  const re = /router\.(get|post|put|patch|delete)\(/g;
  let m = re.exec(source);
  while (m) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      i += 1;
    }
    const body = source.slice(m.index + m[0].length, i - 1);
    const args = splitArgs(body);
    const pathMatch = args[0]?.match(/^'([^']*)'$/);
    found.push({
      method: m[1].toUpperCase(),
      path: pathMatch ? pathMatch[1] : '(dynamic)',
      // Everything after the path: middleware plus the handler.
      args: args.slice(1),
      line: source.slice(0, m.index).split('\n').length,
    });
    m = re.exec(source);
  }
  return found;
}

/** An argument IS a gate — not merely one that mentions a gate somewhere inside. */
const isGate = (arg, factories, aliases) =>
  factories.some((f) => arg.startsWith(`${f}(`)) || aliases.has(arg);

const ungated = [];
const brandOnly = [];
let checked = 0;
const perFile = [];

for (const file of adminRouteFiles()) {
  let source;
  try { source = readFileSync(file, 'utf8'); } catch { continue; }
  const aliases = gateAliases(source);
  const declared = routes(source);
  const rel = path.relative(serverDir, file).replace(/\\/g, '/');
  let fileUngated = 0;

  for (const route of declared) {
    checked += 1;
    const hasPermission = route.args.some((a) => isGate(a, PERMISSION_GATES, aliases.permission));
    const hasBrand = route.args.some((a) => isGate(a, BRAND_GATES, aliases.brand));

    const key = `${route.method} ${route.path}`;
    if (hasPermission) continue;
    if (INTENTIONALLY_UNGATED.has(key)) continue;

    if (hasBrand) {
      // A company check without a permission check still lets any staff
      // member of that company in.
      brandOnly.push(`${rel}:${route.line}  ${key}`);
    } else {
      ungated.push(`${rel}:${route.line}  ${key}`);
    }
    fileUngated += 1;
  }
  perFile.push({ file: rel, routes: declared.length, ungated: fileUngated });
}

console.log('──── admin route permission gating ────');
console.table(perFile.filter((f) => f.routes > 0));

console.log(`\nroutes checked: ${checked}`);
console.log(`allow-listed as intentionally open: ${INTENTIONALLY_UNGATED.size} patterns`);

if (brandOnly.length) {
  console.log(`\nBrand-scoped but NOT permission-gated (${brandOnly.length}):`);
  for (const r of brandOnly) console.log(`  ${r}`);
}

if (ungated.length) {
  console.log(`\nUNGATED — reachable by any authenticated staff account (${ungated.length}):`);
  for (const r of ungated) console.log(`  ${r}`);
}

const failures = ungated.length + brandOnly.length;
console.log(`\nADMIN_ROUTE_GATING = ${failures ? 'FAIL' : 'PASS'}`);
if (failures) process.exit(1);
