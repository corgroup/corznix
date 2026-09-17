// Phase 2 · Slice 4 — PDP "Check delivery" date-window maths. Pure + testable.
//
// Delhivery's TAT API gives ONE expected delivery date (or a transit-day count
// that already skips Sundays/holidays). The storefront shows a *range*:
//
//   earliest = the provider EDD
//   latest   = earliest + PDP_DELIVERY_RANGE_BUFFER_DAYS  (a business pad for
//              packing + courier variance — the ONLY invented part, and it is
//              config, not a fabricated provider value)
//
// Both ends are pushed off Sunday. `dispatchLagDays` models the time from
// "order placed" to "handed to the courier" (TAT counts from handover).

const DAY_MS = 86_400_000;
const iso = (d) => d.toISOString().slice(0, 10);

function bumpOffSunday(d) {
  const x = new Date(d);
  if (x.getUTCDay() === 0) x.setUTCDate(x.getUTCDate() + 1);
  return x;
}

/** Add `n` calendar days, then skip a Sunday landing. */
function addDaysSkipSunday(from, n) {
  const d = new Date(new Date(from).getTime() + Math.max(0, n) * DAY_MS);
  return bumpOffSunday(d);
}

/**
 * @param {object} tat  normalized adapter result: { transitDays?, estimatedDeliveryDate? }
 * @param {object} [opts] { now, bufferDays, dispatchLagDays }
 * @returns {{ earliestDate:string, latestDate:string, transitDays:number|null, source:'PROVIDER_EDD'|'PROVIDER_TAT' } | null}
 *          null when the provider gave neither a date nor a transit count.
 */
export function computeDeliveryWindow(tat, { now = new Date(), bufferDays = 2, dispatchLagDays = 1 } = {}) {
  const buffer = Math.max(0, Math.trunc(Number(bufferDays) || 0));
  const lag = Math.max(0, Math.trunc(Number(dispatchLagDays) || 0));

  let earliest;
  let source;
  let transitDays = null;

  if (tat?.estimatedDeliveryDate && /^\d{4}-\d{2}-\d{2}/.test(String(tat.estimatedDeliveryDate))) {
    const d = new Date(`${String(tat.estimatedDeliveryDate).slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return null;
    earliest = bumpOffSunday(d);
    source = 'PROVIDER_EDD';
  } else if (tat?.transitDays != null && Number.isFinite(Number(tat.transitDays)) && Number(tat.transitDays) >= 0) {
    transitDays = Math.round(Number(tat.transitDays));
    // handover is `lag` days out; the provider's transit count runs from there.
    const handover = new Date(now.getTime() + lag * DAY_MS);
    earliest = addDaysSkipSunday(handover, transitDays);
    source = 'PROVIDER_TAT';
  } else {
    return null;
  }

  return {
    earliestDate: iso(earliest),
    latestDate: iso(addDaysSkipSunday(earliest, buffer)),
    transitDays,
    source,
  };
}
