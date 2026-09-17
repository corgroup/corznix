// WP-10 — customer-facing carrier tracking deep link.
//
// A shipment row may already carry a provider-supplied `tracking_url`
// (populated at booking time by whichever logistics adapter booked it). When
// it does not — e.g. the AWB arrived first via a Scan Push webhook (WP-01) —
// we synthesise the public tracking URL from the carrier + AWB.
//
// Provider-neutral: unknown carriers return null and the storefront simply
// shows the AWB as plain text. No secrets, no API calls — these are the
// carriers' own public consumer tracking pages.

const BUILDERS = {
  DELHIVERY: (awb) => `https://www.delhivery.com/track/package/${encodeURIComponent(awb)}`,
  MOCK: () => null,
};

/**
 * @param {string|null|undefined} providerCode  shipment.provider_code
 * @param {string|null|undefined} awb            shipment.tracking_number
 * @returns {string|null}
 */
export function carrierTrackingUrl(providerCode, awb) {
  const code = String(providerCode ?? '').trim().toUpperCase();
  const trackingNumber = String(awb ?? '').trim();
  if (!code || !trackingNumber) return null;
  const build = BUILDERS[code];
  return build ? build(trackingNumber) : null;
}
