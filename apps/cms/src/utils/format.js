// Money: the backend stores/accepts integer minor units (paise). The CMS
// displays ₹ and edits in rupees, converting only at the boundary.
export function formatMoney(minor, currency = 'INR') {
  if (minor == null) return '—';
  const symbol = currency === 'INR' ? '₹' : `${currency} `;
  return `${symbol}${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatPriceRange(price) {
  if (!price) return '—';
  const lo = formatMoney(price.minMinor, price.currency);
  return price.maxMinor && price.maxMinor !== price.minMinor
    ? `${lo} – ${formatMoney(price.maxMinor, price.currency)}`
    : lo;
}

// Rupees string/number -> integer paise. Rejects > 2 decimal places so a
// value is never silently truncated.
export function rupeesToMinor(value) {
  const str = String(value).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(str)) return { ok: false, message: 'Enter an amount with at most 2 decimal places.' };
  const minor = Math.round(Number(str) * 100);
  return { ok: true, minor };
}

export function minorToRupees(minor) {
  return minor == null ? '' : String(minor / 100);
}

// Shipping units. Backend canonical = integer grams / integer millimetres.
// The UI toggles g/kg and mm/cm and converts deterministically to integers.
export function toGrams(value, unit) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, message: 'Enter a positive number.' };
  const grams = unit === 'kg' ? Math.round(n * 1000) : Math.round(n);
  if (grams <= 0) return { ok: false, message: 'Weight must be greater than zero.' };
  return { ok: true, value: grams };
}

export function toMillimetres(value, unit) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, message: 'Enter a positive number.' };
  const mm = unit === 'cm' ? Math.round(n * 10) : Math.round(n);
  if (mm <= 0) return { ok: false, message: 'Dimension must be greater than zero.' };
  return { ok: true, value: mm };
}

export function gramsToDisplay(grams, unit) {
  if (grams == null) return '';
  return unit === 'kg' ? String(grams / 1000) : String(grams);
}
export function mmToDisplay(mm, unit) {
  if (mm == null) return '';
  return unit === 'cm' ? String(mm / 10) : String(mm);
}

export function titleCase(value) {
  return String(value || '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatDateTime(value) {
  return value ? new Date(value).toLocaleString() : '—';
}

// Compact "2h ago" / "3d ago" relative time; falls back to a date past a week.
export function formatRelative(value) {
  if (!value) return '—';
  const s = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604_800) return `${Math.floor(s / 86_400)}d ago`;
  return new Date(value).toLocaleDateString();
}
