import { useId, useMemo, useState } from 'react';
import { formatMoneyCompact, formatMoneyFull, formatNumber } from '../dashboardFormat.js';
import './SalesChart.css';

const W = 720;
const H = 240;
const PAD = { top: 16, right: 12, bottom: 26, left: 12 };

function niceDate(day) {
  const d = new Date(`${day}T00:00:00Z`);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

// Area + line chart for the daily net-order-value series. Pure SVG, no
// charting dependency. Values are the backend's `netMinor` per day; the
// component only scales and formats them.
export function SalesChart({ series, metricLabel = 'Net order value' }) {
  const gradId = `sales-grad-${useId().replace(/:/g, '')}`;
  const [active, setActive] = useState(null);

  const geom = useMemo(() => {
    const pts = series.map((d) => Number(d.netMinor || 0));
    const max = Math.max(1, ...pts);
    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    const step = series.length > 1 ? innerW / (series.length - 1) : 0;
    const xy = series.map((d, i) => ({
      x: PAD.left + (series.length > 1 ? i * step : innerW / 2),
      y: PAD.top + innerH - (Number(d.netMinor || 0) / max) * innerH,
    }));
    const line = xy.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const area = `${line} L${xy[xy.length - 1]?.x.toFixed(1)},${PAD.top + innerH} L${xy[0]?.x.toFixed(1)},${PAD.top + innerH} Z`;
    return { xy, line, area, max, step, innerH };
  }, [series]);

  const tickIdx = series.length <= 1
    ? [0]
    : [0, Math.floor((series.length - 1) / 2), series.length - 1].filter((v, i, a) => a.indexOf(v) === i);

  const activePoint = active != null ? series[active] : null;

  return (
    <figure className="sales-chart">
      <figcaption className="sr-only">
        {metricLabel} by day. {series.map((d) => `${niceDate(d.day)}: ${formatMoneyFull(d.netMinor)}, ${formatNumber(d.orders)} orders.`).join(' ')}
      </figcaption>

      <div className="sales-chart__canvas">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${metricLabel} trend chart`} className="sales-chart__svg">
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--cms-primary)" stopOpacity="0.3" />
              <stop offset="100%" stopColor="var(--cms-primary)" stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {[0.25, 0.5, 0.75, 1].map((f) => (
            <line key={f} x1={PAD.left} x2={W - PAD.right} y1={PAD.top + geom.innerH * (1 - f)} y2={PAD.top + geom.innerH * (1 - f)} className="sales-chart__grid" />
          ))}

          <path d={geom.area} fill={`url(#${gradId})`} />
          <path d={geom.line} className="sales-chart__line" fill="none" />

          {activePoint && geom.xy[active] && (
            <g>
              <line x1={geom.xy[active].x} x2={geom.xy[active].x} y1={PAD.top} y2={PAD.top + geom.innerH} className="sales-chart__cursor" />
              <circle cx={geom.xy[active].x} cy={geom.xy[active].y} r="4" className="sales-chart__dot" />
            </g>
          )}

          {series.map((d, i) => (
            <rect
              key={d.day}
              x={geom.xy[i].x - geom.step / 2}
              y={0}
              width={geom.step || W}
              height={H}
              fill="transparent"
              onMouseEnter={() => setActive(i)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
              tabIndex={0}
              role="presentation"
            >
              <title>{`${niceDate(d.day)}: ${formatMoneyFull(d.netMinor)} · ${formatNumber(d.orders)} orders`}</title>
            </rect>
          ))}
        </svg>

        {activePoint && (
          <div
            className="sales-chart__tooltip"
            style={{ left: `${(geom.xy[active].x / W) * 100}%` }}
            role="status"
          >
            <span className="sales-chart__tooltip-date">{niceDate(activePoint.day)}</span>
            <span className="sales-chart__tooltip-value">{formatMoneyFull(activePoint.netMinor)}</span>
            <span className="sales-chart__tooltip-sub">{formatNumber(activePoint.orders)} orders</span>
          </div>
        )}
      </div>

      <div className="sales-chart__axis" aria-hidden="true">
        {tickIdx.map((i) => (
          <span key={i} style={{ left: `${series.length > 1 ? (i / (series.length - 1)) * 100 : 50}%` }}>
            {niceDate(series[i].day)}
          </span>
        ))}
      </div>

      <p className="sales-chart__scale" aria-hidden="true">Peak day {formatMoneyCompact(geom.max)}</p>
    </figure>
  );
}

export default SalesChart;
