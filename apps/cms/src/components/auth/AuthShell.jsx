import { AuthIcon } from './AuthIcon.jsx';
import './AuthShell.css';

// Shared shell for every pre-shell auth screen — sign-in, company picker,
// no-access, forced password change. One card so all four read as the same
// product: COR-GROUP mark (the parent-company favicon, apps/cms/public/
// favicon.svg — company-agnostic on purpose, since none of these screens
// have resolved a brand yet), a divider, then an optional icon chip beside
// the screen's own heading. Everything after the heading (form, list,
// footer link) is passed as children so each screen keeps its own logic.
export function AuthShell({ eyebrow, icon, heading, hint, wide, children }) {
  return (
    <div className="auth-shell">
      <div className="auth-shell__decor" aria-hidden="true" />
      <div className={`auth-shell__card${wide ? ' auth-shell__card--wide' : ''}`}>
        <div className="auth-shell__brand">
          <img src="/favicon.svg" alt="COR-GROUP" className="auth-shell__mark" />
          <div>
            <p className="auth-shell__title">COR-GROUP</p>
            <p className="auth-shell__eyebrow">{eyebrow}</p>
          </div>
        </div>
        <div className="auth-shell__divider" />
        <div className="auth-shell__heading-row">
          {icon && (
            <span className="auth-shell__icon-chip" aria-hidden="true">
              <AuthIcon name={icon} />
            </span>
          )}
          <div>
            <h1 className="auth-shell__heading">{heading}</h1>
            {hint && <p className="auth-shell__hint">{hint}</p>}
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

export default AuthShell;
