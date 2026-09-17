import './Skeleton.css';

// Neutral loading placeholder. `lines` renders stacked text bars; a single
// block is the default. Pure presentation — no data, no side effects.
export function Skeleton({ lines = 0, height, width, radius, className = '', style }) {
  if (lines > 0) {
    return (
      <span className={`skeleton-stack ${className}`.trim()} aria-hidden="true" style={style}>
        {Array.from({ length: lines }).map((_, i) => (
          <span
            key={i}
            className="skeleton"
            style={{ height: height || 12, width: i === lines - 1 ? '60%' : '100%', borderRadius: radius ?? 4 }}
          />
        ))}
      </span>
    );
  }
  return (
    <span
      className={`skeleton ${className}`.trim()}
      aria-hidden="true"
      style={{ height: height || 16, width: width || '100%', borderRadius: radius ?? 6, ...style }}
    />
  );
}

export default Skeleton;
