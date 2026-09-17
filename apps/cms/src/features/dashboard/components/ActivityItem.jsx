import { Link } from 'react-router-dom';
import { relativeTime } from '../dashboardFormat.js';
import './ActivityItem.css';

// A single recent-activity row. The dashboard feeds this from real order
// rows (there is no separate audit-feed API) — `to` deep-links to the
// existing detail route.
export function ActivityItem({ icon, title, meta, timestamp, to }) {
  const inner = (
    <>
      <span className="activity-item__icon" aria-hidden="true">{icon}</span>
      <span className="activity-item__body">
        <span className="activity-item__title">{title}</span>
        {meta && <span className="activity-item__meta">{meta}</span>}
      </span>
      {timestamp && <time className="activity-item__time" dateTime={new Date(timestamp).toISOString()}>{relativeTime(timestamp)}</time>}
    </>
  );
  return to ? (
    <Link to={to} className="activity-item activity-item--link">{inner}</Link>
  ) : (
    <div className="activity-item">{inner}</div>
  );
}

export default ActivityItem;
