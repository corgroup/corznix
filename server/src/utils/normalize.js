// ADAPTED_SOURCE_TO_TARGET from corcotton-store/server/src/utils/normalize.js
// (Wave 5). Logic unchanged. Phone normalization uses `libphonenumber-js`
// (real E.164 validation, not a naive regex) — added as a new backend
// dependency for exactly this reason (migration brief §22: "do not compare
// raw user-entered phone strings").
import { parsePhoneNumber } from 'libphonenumber-js';

export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

/** India-first: a bare 10-digit number is assumed +91. Returns '' if invalid, never a raw/partial string. */
export function normalizePhone(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const digits = raw.replace(/\D+/g, '');
  if (!digits) return '';

  const candidate = digits.length === 10 ? `+91${digits}` : `+${digits}`;
  try {
    const parsed = parsePhoneNumber(candidate);
    if (!parsed || !parsed.isValid()) {
      return '';
    }
    return parsed.number;
  } catch {
    return '';
  }
}

export function normalizeName(value) {
  return String(value || '').trim();
}
