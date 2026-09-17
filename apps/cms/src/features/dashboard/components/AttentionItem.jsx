import { Link } from 'react-router-dom';
import './AttentionItem.css';

// One operational to-do. Renders as a link to an existing CMS route.
// `tone` drives the count badge colour (warn / danger / info / neutral).
export function AttentionItem({ icon, count, label, hint, to, tone = 'neutral' }) {
  return (
    <Link to={to} className="attention-item">
      <span className={`attention-item__icon attention-item__icon--${tone}`} aria-hidden="true">{icon}</span>
      <span className="attention-item__text">
        <span className="attention-item__label">{label}</span>
        {hint && <span className="attention-item__hint">{hint}</span>}
      </span>
      <span className={`attention-item__count attention-item__count--${tone}`}>{count}</span>
      <span className="attention-item__chevron" aria-hidden="true">›</span>
    </Link>
  );
}

export default AttentionItem;
