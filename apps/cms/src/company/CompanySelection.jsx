import { useAuth } from '../auth/useAuth.js';
import { useCompany } from './useCompany.js';
import { AuthShell } from '../components/auth/AuthShell.jsx';
import { AuthIcon } from '../components/auth/AuthIcon.jsx';
import { InlineAlert } from '../components/feedback/InlineAlert.jsx';
import { BrandMark } from './BrandMark.jsx';
import './CompanySelection.css';

// Shown by RequireStaff (implementation/multi-company/DESIGN.md §6) —
// "After login: 0 accessible brands -> no access screen. 1 -> straight in.
// >=2 -> company selection screen before the shell." A staff member with
// access to more than one company must explicitly choose which one they're
// working in for this session; the switcher (sidebar) changes it any time
// after. The `logout` escape hatch mirrors ForcePasswordChange's.
export function CompanySelection() {
  const { staff, logout } = useAuth();
  const { accessibleBrands, switching, switchError, switchCompany } = useCompany();

  return (
    <AuthShell
      eyebrow="Choose a company"
      wide
      heading="Which company are you working in?"
      hint={
        <>
          {staff?.firstName ? `${staff.firstName}, y` : 'Y'}ou have access to more than one company. Pick one to
          continue — you can switch any time from the sidebar.
        </>
      }
    >
      {switchError && <InlineAlert tone="error">{switchError}</InlineAlert>}
      <ul className="company-select__list">
        {accessibleBrands.map((brand) => (
          <li key={brand.id}>
            <button
              type="button"
              className="company-select__option"
              disabled={switching}
              onClick={() => switchCompany(brand.id)}
            >
              <span className="company-select__mark" aria-hidden="true">
                <BrandMark brand={brand} />
              </span>
              <span className="company-select__name">
                {brand.name}
                {!brand.storefrontUrl && <span className="company-select__soon">Available soon</span>}
              </span>
              <span className="company-select__role">{brand.role}</span>
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="auth-shell__footer" onClick={logout}>
        <AuthIcon name="logout" />
        Sign out instead
      </button>
    </AuthShell>
  );
}

export default CompanySelection;
