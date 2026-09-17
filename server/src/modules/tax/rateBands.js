import { AppError } from '../../utils/errors.js';

// GST arithmetic shared by the tax engine, the invoice and the CMS preview.
//
// Store prices are GST-inclusive: the customer pays the shelf price and that is
// the invoice total. The engine used to add GST on top of the shelf price, so an
// invoice for Rs 4,998 of goods totalled Rs 5,247.90 and never matched what the
// customer paid. Tax is now taken out of the price instead.

export const MAX_RATE_BANDS = 6;

/** Split a GST-inclusive amount into taxable value + GST. Integers only (paise). */
export function splitInclusive(grossMinor, gstRateBps) {
  const gross = Math.round(Number(grossMinor) || 0);
  const rate = Number(gstRateBps) || 0;
  if (rate <= 0) return { taxableMinor: gross, taxMinor: 0 };
  const taxableMinor = Math.round((gross * 10000) / (10000 + rate));
  return { taxableMinor, taxMinor: gross - taxableMinor };
}

const invalid = (message) => new AppError('TAX_RATE_BANDS_INVALID', message, 400);

/**
 * Validate and order the price bands sent from the CMS.
 *  undefined -> leave bands untouched; [] -> remove bands; 2..6 bands -> replace.
 * Bands ascend by per-piece taxable value; the last one has no upper limit.
 */
export function normaliseRateBands(input) {
  if (input === undefined) return undefined;
  if (input === null || (Array.isArray(input) && input.length === 0)) return [];
  if (!Array.isArray(input)) throw invalid('Price bands must be a list.');
  if (input.length < 2) throw invalid('Use at least two price bands, or none.');
  if (input.length > MAX_RATE_BANDS) throw invalid(`Use at most ${MAX_RATE_BANDS} price bands.`);
  const bands = input.map((b, i) => ({
    position: i + 1,
    maxUnitTaxableMinor: b?.maxUnitTaxableMinor == null || b.maxUnitTaxableMinor === '' ? null : Number(b.maxUnitTaxableMinor),
    gstRateBps: Number(b?.gstRateBps),
  }));
  bands.forEach((b, i) => {
    const last = i === bands.length - 1;
    if (!Number.isInteger(b.gstRateBps) || b.gstRateBps < 0 || b.gstRateBps > 5000) throw invalid(`Band ${i + 1}: GST rate must be between 0% and 50%.`);
    if (last && b.maxUnitTaxableMinor !== null) throw invalid('The last band covers everything above the previous limit, so it has no upper limit.');
    if (!last && (!Number.isInteger(b.maxUnitTaxableMinor) || b.maxUnitTaxableMinor <= 0)) throw invalid(`Band ${i + 1}: enter the per-piece taxable value it goes up to.`);
    if (!last && i > 0 && b.maxUnitTaxableMinor <= bands[i - 1].maxUnitTaxableMinor) throw invalid('Each band must go higher than the one before it.');
  });
  return bands;
}

/**
 * Pick the GST rate for one piece sold at `unitGrossMinor` (GST-inclusive).
 * The threshold is the per-piece taxable value, which depends on the rate being
 * tested, so each band is checked at its own rate: the first band whose taxable
 * value stays within its limit applies.
 * @returns {{ gstRateBps: number, band: null | { position, maxUnitTaxableMinor, gstRateBps } }}
 */
export function pickRateBand({ gstRateBps, bands }, unitGrossMinor) {
  if (!bands || bands.length === 0) return { gstRateBps: Number(gstRateBps), band: null };
  const ordered = [...bands].sort((a, b) => a.position - b.position);
  for (const band of ordered) {
    const { taxableMinor } = splitInclusive(unitGrossMinor, band.gstRateBps);
    if (band.maxUnitTaxableMinor == null || taxableMinor <= band.maxUnitTaxableMinor) {
      return { gstRateBps: band.gstRateBps, band };
    }
  }
  const last = ordered[ordered.length - 1];
  return { gstRateBps: last.gstRateBps, band: last };
}
