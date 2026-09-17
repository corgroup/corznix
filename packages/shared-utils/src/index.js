/**
 * Shared pure utility functions.
 * Keep this file free of storefront- or CMS-specific logic.
 */

/**
 * Format an integer amount in minor units (e.g. paise) as a currency string.
 * @param {number} amountMinorUnits
 * @param {string} [currencyCode='INR']
 * @param {string} [locale='en-IN']
 */
export function formatCurrency(amountMinorUnits, currencyCode = 'INR', locale = 'en-IN') {
  const amount = Number(amountMinorUnits) / 100;
  return new Intl.NumberFormat(locale, { style: 'currency', currency: currencyCode }).format(amount);
}

/**
 * Format an ISO date string for display.
 * @param {string} isoString
 * @param {{ style?: 'short'|'long' }} [opts]
 */
export function formatDate(isoString, { style = 'short' } = {}) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: style === 'long' ? 'long' : 'medium',
  }).format(date);
}

/**
 * Convert arbitrary text into a URL-safe slug.
 * @param {string} text
 */
export function slugify(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
