// Deterministic URL slug. ASCII-lowercases, strips combining accents,
// collapses any run of non-alphanumerics to a single hyphen, trims
// leading/trailing hyphens. Uniqueness is the database's job
// (uk_products_slug) — this only shapes the candidate.
const COMBINING_MARKS = /[̀-ͯ]/g;

export function slugify(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
}

export function isValidSlug(value) {
  return typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 180;
}
