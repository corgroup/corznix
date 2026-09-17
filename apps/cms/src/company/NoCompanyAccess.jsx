import { useAuth } from '../auth/useAuth.js';
import { AuthIcon } from '../components/auth/AuthIcon.jsx';
import './NoCompanyAccess.css';

// Shown by RequireStaff when an authenticated, non-SUPER_ADMIN staff member
// has zero `staff_brand_access` rows (implementation/multi-company/DESIGN.md
// §6 — "0 accessible brands -> no access screen"). Deny by default: access
// is never inferred, so this is the honest state rather than silently
// picking a company for them. Full-bleed illustrated empty state (rather
// than the narrow AuthShell card the other pre-shell screens use) — there's
// no form here, just a status and two ways out, so the wider layout gives
// the copy and actions room to breathe.
export function NoCompanyAccess() {
  const { staff, logout } = useAuth();
  const name = staff?.firstName || null;
  const mailSubject = encodeURIComponent('Company access request');
  const mailBody = encodeURIComponent(
    `Hi,\n\nMy account (${staff?.email || 'no email on file'}) isn't assigned to a company workspace yet. Could you grant me access?\n\nThanks${name ? `,\n${name}` : ''}`
  );

  return (
    <div className="no-company">
      <div className="no-company__decor" aria-hidden="true" />
      <header className="no-company__topbar">
        <img src="/favicon.svg" alt="" className="no-company__topbar-mark" />
        <span className="no-company__topbar-title">COR-GROUP</span>
      </header>

      <div className="no-company__body">
        <div className="no-company__hero">
          <span className="no-company__ring" aria-hidden="true" />
          <span className="no-company__float no-company__float--left" aria-hidden="true"><AuthIcon name="mail" /></span>
          <span className="no-company__float no-company__float--right" aria-hidden="true"><AuthIcon name="key" /></span>
          <span className="no-company__mark" aria-hidden="true"><AuthIcon name="userX" /></span>
        </div>

        <h1>No company assigned yet</h1>
        <p>
          {name ? `${name}, you’re` : 'You’re'} not part of any company workspace right now.
          Once you’re added to a company, you’ll be able to access its dashboard, catalog, and reports.
        </p>

        <div className="no-company__actions">
          <a
            className="no-company__btn no-company__btn--primary"
            href={`mailto:?subject=${mailSubject}&body=${mailBody}`}
          >
            <AuthIcon name="mail" /> Contact Super Admin
          </a>
          <button type="button" className="no-company__btn no-company__btn--ghost" onClick={logout}>
            <AuthIcon name="logout" /> Switch Account
          </button>
        </div>

        <div className="no-company__divider">
          <span /> <em>or</em> <span />
        </div>

        <div className="no-company__callout">
          <span className="no-company__callout-icon" aria-hidden="true">i</span>
          <p>
            <strong>Think this is a mistake?</strong>
            <br />
            Reach out to your administrator to get access to the correct company.
          </p>
        </div>
      </div>

      <footer className="no-company__footer">
        <span className="no-company__footer-title">COR-GROUP</span>
        <span className="no-company__footer-tagline">One platform. Many possibilities.</span>
      </footer>
    </div>
  );
}

export default NoCompanyAccess;
