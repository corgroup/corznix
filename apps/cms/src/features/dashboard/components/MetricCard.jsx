import { Link } from 'react-router-dom';
import { Skeleton } from '../../../components/feedback/Skeleton.jsx';
import './MetricCard.css';

// One KPI tile. States: loading (skeleton), unavailable (data source failed
// or not permitted), ready. Trend chip is rendered only when `trend` is
// provided — a missing comparison period shows nothing, never a fake %.
export function MetricCard({
  label,
  value,
  icon,
  tone = 'primary',
  trend = null,
  trendLabel,
  subtext,
  to,
  loading = false,
  unavailable = false,
}) {
  const body = (
    <>
      <div className="metric-card__head">
        {icon && <span className={`metric-card__icon metric-card__icon--${tone}`} aria-hidden="true">{icon}</span>}
        <span className="metric-card__label">{label}</span>
      </div>

      {loading ? (
        <Skeleton height={22} width="70%" style={{ margin: '6px 0 8px' }} />
      ) : unavailable ? (
        <p className="metric-card__value metric-card__value--muted">Not available</p>
      ) : (
        <p className="metric-card__value">{value}</p>
      )}

      {!loading && !unavailable && (trend || subtext) && (
        <p className="metric-card__foot">
          {trend && (
            <span className={`trend trend--${trend.direction}`}>
              <span aria-hidden="true">{trend.direction === 'up' ? '▲' : trend.direction === 'down' ? '▼' : '■'}</span>
              {trend.text}
              <span className="sr-only"> {trend.direction === 'up' ? 'increase' : trend.direction === 'down' ? 'decrease' : 'no change'}</span>
            </span>
          )}
          {trend && trendLabel && <span className="metric-card__trend-label"> {trendLabel}</span>}
          {!trend && subtext && <span className="metric-card__subtext">{subtext}</span>}
        </p>
      )}
    </>
  );

  if (to && !loading && !unavailable) {
    return (
      <Link to={to} className="metric-card metric-card--link">
        {body}
      </Link>
    );
  }
  return <div className="metric-card">{body}</div>;
}

export default MetricCard;
