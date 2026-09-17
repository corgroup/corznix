import { Link } from 'react-router-dom';
import './SectionCard.css';

// A titled surface panel used for the dashboard's secondary areas
// (sales overview, needs attention, recent orders, top products, health).
// `action` is an optional right-aligned link/element in the header.
export function SectionCard({ title, subtitle, action, actionTo, actionLabel, className = '', bodyClassName = '', children }) {
  return (
    <section className={`section-card ${className}`.trim()}>
      <header className="section-card__head">
        <div>
          <h2 className="section-card__title">{title}</h2>
          {subtitle && <p className="section-card__subtitle">{subtitle}</p>}
        </div>
        {action || (actionTo && (
          <Link to={actionTo} className="section-card__action">
            {actionLabel || 'View all'}
          </Link>
        ))}
      </header>
      <div className={`section-card__body ${bodyClassName}`.trim()}>{children}</div>
    </section>
  );
}

export default SectionCard;
