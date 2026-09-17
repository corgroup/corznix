// Price bands on a tax profile (server: modules/tax/rateBands.js).
// The CMS edits rupees and percent; the API takes paise and basis points.
// A band's limit is the per-piece taxable value: the price after discount,
// without GST. The last band has no upper limit.

export const MAX_RATE_BANDS = 6;
export const DEFAULT_FORM_BANDS = [{ max: '2500', rate: '5' }, { max: '', rate: '18' }];

export const formatRupees = (minor) => `₹${(Number(minor) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
export const formatRate = (bps) => `${(Number(bps) / 100).toFixed(Number(bps) % 100 ? 2 : 0)}%`;

export const toFormBands = (rateBands = []) => rateBands.map((b) => ({
  max: b.maxUnitTaxableMinor == null ? '' : String(b.maxUnitTaxableMinor / 100),
  rate: String(b.gstRateBps / 100),
}));

export const toApiBands = (bands) => bands.map((b, i) => ({
  maxUnitTaxableMinor: i === bands.length - 1 ? null : Math.round(Number(b.max) * 100),
  gstRateBps: Math.round(Number(b.rate) * 100),
}));

/** Same rules as the server, so the form can say what is wrong before saving. */
export function bandsProblem(bands) {
  if (bands.length < 2) return 'Use at least two bands.';
  for (let i = 0; i < bands.length; i += 1) {
    const b = bands[i];
    const rate = Number(b.rate);
    if (b.rate === '' || !(rate >= 0 && rate <= 50)) return `Band ${i + 1}: enter a GST rate from 0 to 50%.`;
    if (i < bands.length - 1) {
      if (!(Number(b.max) > 0)) return `Band ${i + 1}: enter the per-piece value it goes up to.`;
      if (i > 0 && Number(b.max) <= Number(bands[i - 1].max)) return 'Each band must go higher than the one before it.';
    }
  }
  return null;
}

/** Short rate label for pickers: "5%" or "5–18% by price". Accepts list rows or product DTOs. */
export function profileRateLabel(profile) {
  const bands = profile?.rateBands || [];
  if (bands.length) {
    const rates = bands.map((b) => Number(b.gstRateBps));
    return `${formatRate(Math.min(...rates))}–${formatRate(Math.max(...rates))} by price`;
  }
  return formatRate(profile?.gst_rate_bps ?? profile?.gstRateBps ?? 0);
}

/** One line per band: "Up to ₹2,500: 5%", "Above ₹2,500: 18%". */
export function bandLines(rateBands = []) {
  return rateBands.map((b, i) => {
    if (b.maxUnitTaxableMinor != null) return `Up to ${formatRupees(b.maxUnitTaxableMinor)}: ${formatRate(b.gstRateBps)}`;
    const prev = rateBands[i - 1];
    return `Above ${prev ? formatRupees(prev.maxUnitTaxableMinor) : 'that'}: ${formatRate(b.gstRateBps)}`;
  });
}
