import { humanize, formatNumber, formatMoneyFull, formatPercent } from '../dashboardFormat.js';
import './OrdersByStatus.css';

// Order-state distribution — a circular DONUT (never a bar). The per-status
// counts + amounts come straight from reports/orders (`statusBreakdown`);
// status keys are backend enum values, only the label is humanised.
// Each status has its own hue: blue placed, cyan confirmed, amber processing,
// green completed, red cancelled. Two shades of one purple made Placed and
// Processing hard to tell apart. An unmapped status falls back through RAMP.
const TONE = {
  PLACED: 'p1',
  CONFIRMED: 'p2',
  PROCESSING: 'p3',
  COMPLETED: 'done',
  CANCELLED: 'cancelled',
};
const RAMP = ['p1', 'p2', 'p3', 'p4'];

// r chosen so the circumference is exactly 100 → dash lengths == percentages.
const R = 15.915;
const C = 2 * Math.PI * R;

export function OrdersByStatus({ breakdown }) {
  const rows = [...(breakdown || [])].sort((a, b) => b.count - a.count);
  const total = rows.reduce((s, r) => s + Number(r.count || 0), 0);
  if (total === 0) return null;

  const unmappedBefore = (idx) => rows.slice(0, idx).filter((r) => !TONE[r.status]).length;
  const segments = rows.map((r, idx) => {
    const count = Number(r.count || 0);
    return {
      status: r.status,
      count,
      valueMinor: r.valueMinor,
      pct: (count / total) * 100,
      tone: TONE[r.status] || RAMP[unmappedBefore(idx) % RAMP.length],
    };
  });

  // Build the ring: each segment is a circle stroke with dasharray
  // "<len> <gap>"; dashoffset is the (negative) cumulative length before it.
  const arcs = segments.map((s, i) => {
    const len = (s.pct / 100) * C;
    const before = segments.slice(0, i).reduce((sum, x) => sum + (x.pct / 100) * C, 0);
    return { ...s, dash: `${len} ${C - len}`, dashoffset: -before };
  });

  return (
    <div className="obs">
      <div className="obs__chart" role="img" aria-label={`Order status split across ${formatNumber(total)} orders`}>
        <svg className="obs__donut" viewBox="0 0 42 42">
          <circle className="obs__track" cx="21" cy="21" r={R} fill="none" strokeWidth="5" />
          {arcs.map((a) => (
            <circle
              key={a.status}
              className={`obs__arc obs__arc--${a.tone}`}
              cx="21" cy="21" r={R}
              fill="none"
              strokeWidth="5"
              strokeDasharray={a.dash}
              strokeDashoffset={a.dashoffset}
            >
              <title>{`${humanize(a.status)}: ${formatNumber(a.count)} (${Math.round(a.pct)}%)`}</title>
            </circle>
          ))}
        </svg>
        <div className="obs__center">
          <span className="obs__center-value">{formatNumber(total)}</span>
          <span className="obs__center-label">Total orders</span>
        </div>
      </div>

      <ul className="obs__legend">
        {segments.map((s) => (
          <li key={s.status}>
            <span className={`obs__dot obs__dot--${s.tone}`} aria-hidden="true" />
            <span className="obs__legend-label">{humanize(s.status)}</span>
            <span className="obs__legend-count">{formatNumber(s.count)}</span>
            <span className="obs__legend-detail">
              {formatPercent(s.pct / 100, 0)}
              {s.valueMinor != null && ` · ${formatMoneyFull(s.valueMinor)}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default OrdersByStatus;
