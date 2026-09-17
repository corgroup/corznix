// Presentation-only helpers for the dashboard. These map already-computed
// backend values into display strings — they never re-derive a financial
// figure. All money in is integer minor units (paise); the backend owns
// every definition (gross / net / captured / refunded).

const RUPEE = '₹';

export function formatMoneyFull(minor) {
  if (minor == null) return '—';
  return `${RUPEE}${(Number(minor) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

// Compact form for KPI tiles: ₹20.4L / ₹1.2Cr — Indian numbering.
export function formatMoneyCompact(minor) {
  if (minor == null) return '—';
  const rupees = Number(minor) / 100;
  const abs = Math.abs(rupees);
  if (abs >= 1e7) return `${RUPEE}${(rupees / 1e7).toLocaleString('en-IN', { maximumFractionDigits: 2 })}Cr`;
  if (abs >= 1e5) return `${RUPEE}${(rupees / 1e5).toLocaleString('en-IN', { maximumFractionDigits: 2 })}L`;
  if (abs >= 1e3) return `${RUPEE}${(rupees / 1e3).toLocaleString('en-IN', { maximumFractionDigits: 1 })}k`;
  return `${RUPEE}${rupees.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

export function formatNumber(value) {
  if (value == null) return '—';
  return Number(value).toLocaleString('en-IN');
}

export function formatPercent(ratio, digits = 1) {
  if (ratio == null || Number.isNaN(ratio)) return null;
  return `${(ratio * 100).toFixed(digits)}%`;
}

// A backend growth ratio → { text, direction } for the trend chip. `null`
// (no comparison-period data) yields null so the chip is hidden, never faked.
export function trendFromRatio(ratio) {
  const text = formatPercent(ratio);
  if (text == null) return null;
  const direction = ratio > 0 ? 'up' : ratio < 0 ? 'down' : 'flat';
  return { text: `${ratio > 0 ? '+' : ''}${text}`, direction };
}

// Growth from two absolute values the backend already returned (e.g. net
// order value this period vs. previous). Returns null when there is no
// previous-period baseline to compare against.
export function trendFromValues(current, previous) {
  if (previous == null || previous === 0) return null;
  return trendFromRatio((Number(current) - Number(previous)) / Number(previous));
}

export function relativeTime(value) {
  if (!value) return '';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const min = Math.round(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

// Backend enum → human label. The enum value itself is never changed.
export function humanize(value) {
  return String(value || '')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Fill day gaps in a sales time series so the chart has a continuous date
// axis. Missing days become zero — which is the truthful value for "no
// orders that day", not fabricated data. Bounds come from the resolved
// period the backend already returned.
export function fillSeriesGaps(series, periodStart, periodEnd) {
  const rows = Array.isArray(series) ? series : [];
  if (!periodStart || !periodEnd) return rows;
  const byDay = new Map(rows.map((r) => [String(r.day).slice(0, 10), r]));
  const out = [];
  const cursor = new Date(`${String(periodStart).slice(0, 10)}T00:00:00Z`);
  // periodEnd is the backend's exclusive range end — iterate up to (not
  // including) that calendar day so a 7-day range yields exactly 7 points.
  const endKey = String(periodEnd).slice(0, 10);
  let guard = 0;
  while (guard < 400) {
    const key = cursor.toISOString().slice(0, 10);
    if (key >= endKey) break;
    const hit = byDay.get(key);
    out.push({
      day: key,
      orders: hit ? Number(hit.orders || 0) : 0,
      grossMinor: hit ? Number(hit.grossMinor || 0) : 0,
      netMinor: hit ? Number(hit.netMinor || 0) : 0,
      discountMinor: hit ? Number(hit.discountMinor || 0) : 0,
      filled: !hit,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    guard += 1;
  }
  return out;
}
