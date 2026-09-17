const TONE = {
  ACTIVE: 'good', COMPLETE: 'good', READY: 'good',
  DRAFT: 'warn', INCOMPLETE: 'warn',
  ARCHIVED: 'muted', BLOCKED: 'bad',
};

export function Badge({ children, tone }) {
  const resolved = tone || TONE[children] || 'muted';
  return <span className={`badge-pill badge-pill--${resolved}`}>{children}</span>;
}

export default Badge;
