// Shared insight-strip primitive for the CMS workbenches. `cards` is an array
// of { label, value, hint?, tone?, active?, onClick? }. A card with onClick
// renders as a filter toggle button; without, a static tile.
export function StatStrip({ cards, min = 160 }) {
  return (
    <div className="wb-strip" style={{ '--wb-strip-min': `${min}px` }}>
      {cards.map((c) => {
        const Tag = c.onClick ? 'button' : 'div';
        return (
          <Tag
            key={c.label}
            type={c.onClick ? 'button' : undefined}
            className={`stat-card${c.tone ? ` stat-card--${c.tone}` : ''}`}
            aria-pressed={c.onClick ? c.active || undefined : undefined}
            onClick={c.onClick}
          >
            <p className="stat-card__label">{c.label}</p>
            <p className="stat-card__value">{c.value ?? '—'}</p>
            {c.hint && <p className="stat-card__sub">{c.hint}</p>}
          </Tag>
        );
      })}
    </div>
  );
}

export default StatStrip;
