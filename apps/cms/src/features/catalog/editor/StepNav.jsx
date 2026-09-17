// Horizontal product-setup stepper. Not a wizard — clicking a step just
// smooth-scrolls to its section; nothing is hidden or blocked. Per step:
//   done     — green check (section complete)
//   current  — the section currently in view (purple)
//   todo     — not done yet (plain number, neutral)
export function StepNav({ steps, activeSection, onJump }) {
  return (
    <nav className="step-nav" aria-label="Product setup steps">
      {steps.map((s, i) => {
        const current = s.sections?.includes(activeSection);
        const state = current ? 'current' : s.status; // done | current | todo
        return (
          <button
            key={s.key}
            type="button"
            className={`step-nav__item step-nav__item--${state}`}
            aria-current={current ? 'step' : undefined}
            onClick={() => onJump(s.sections[0])}
          >
            <span className={`step-nav__num step-nav__num--${state}`}>
              {s.status === 'done' && !current ? '✓' : i + 1}
            </span>
            <span className="step-nav__label">{s.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

export default StepNav;
