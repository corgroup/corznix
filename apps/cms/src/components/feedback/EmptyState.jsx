import './EmptyState.css';

// Purposeful "nothing here / not available" state. `tone="muted"` (default)
// for empty data; `tone="warn"` when a source is unavailable but expected.
export function EmptyState({ title, message, icon = null, action = null, tone = 'muted' }) {
  return (
    <div className={`empty-state empty-state--${tone}`} role="status">
      {icon && <span className="empty-state__icon" aria-hidden="true">{icon}</span>}
      <p className="empty-state__title">{title}</p>
      {message && <p className="empty-state__message">{message}</p>}
      {action}
    </div>
  );
}

export default EmptyState;
