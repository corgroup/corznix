// Wave 8H — report input safety + presentation helpers.
//
// Every filter/sort/pagination value is validated here before it reaches SQL.
// No value is ever concatenated into a query — callers pass validated tokens
// to fixed query builders and bind everything else.

const bad = (msg) => Object.assign(new Error(msg), { status: 400, code: 'VALIDATION_ERROR' });

export function parsePagination(query = {}) {
  const page = Math.max(1, Math.floor(Number(query.page) || 1));
  const pageSize = Math.min(200, Math.max(1, Math.floor(Number(query.pageSize) || 50)));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/** @returns {{ column: string, direction: 'ASC'|'DESC' }} — column is guaranteed to be in `whitelist`. */
export function parseSort(query = {}, whitelist = [], fallback = null) {
  const raw = String(query.sort || fallback || whitelist[0] || '').trim();
  const direction = String(query.dir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  if (!whitelist.includes(raw)) throw bad(`sort must be one of: ${whitelist.join(', ')}`);
  return { column: raw, direction };
}

export function parseId(value, name) {
  if (value == null || value === '') return null;
  const s = String(value);
  if (!/^[0-9a-fA-F-]{1,64}$/.test(s)) throw bad(`${name} is not a valid id`);
  return s;
}

export function parseEnum(value, name, allowed) {
  if (value == null || value === '') return null;
  if (!allowed.includes(String(value))) throw bad(`${name} must be one of: ${allowed.join(', ')}`);
  return String(value);
}

// ---- presentation --------------------------------------------------
/** Rates: null (not 0, not NaN/Infinity) when the denominator is absent (§106). */
export const ratio = (numerator, denominator) =>
  (Number(denominator) > 0 ? Number(numerator) / Number(denominator) : null);

export const asMinor = (v) => (v == null ? 0 : Number(v));

// ---- CSV (§95) ----------------------------------------------------
const FORMULA_LEAD = /^[=+\-@\t\r]/;
export function csvCell(value) {
  if (value == null) return '';
  let s = String(value);
  if (FORMULA_LEAD.test(s)) s = `'${s}`; // neutralize spreadsheet formula injection
  if (/[",\n]/.test(s)) s = `"${s.replaceAll('"', '""')}"`;
  return s;
}

export function toCsv(rows, columns) {
  const head = columns.map((c) => csvCell(c.label ?? c.key)).join(',');
  const body = rows.map((row) => columns.map((c) => csvCell(c.get ? c.get(row) : row[c.key])).join(',')).join('\n');
  return `${head}\n${body}\n`;
}
