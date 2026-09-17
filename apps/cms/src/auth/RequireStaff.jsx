import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './useAuth.js';
import { LoadingState } from '../components/feedback/LoadingState.jsx';
import { ForcePasswordChange } from './ForcePasswordChange.jsx';
import { useCompany } from '../company/useCompany.js';
import { CompanySelection } from '../company/CompanySelection.jsx';
import { NoCompanyAccess } from '../company/NoCompanyAccess.jsx';

// UX-only route guard. Every privileged backend endpoint enforces its own
// auth + permissions regardless of what renders here (Wave 8A brief §39).
export function RequireStaff({ children }) {
  const { loading, isAuthenticated, mustChangePassword } = useAuth();
  const { accessibleBrands, companySelectionRequired } = useCompany();
  const location = useLocation();

  if (loading) return <LoadingState label="Checking your session…" fullscreen />;
  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  // First-login forced password change — the backend refuses every feature
  // route with PASSWORD_CHANGE_REQUIRED until this is done; the CMS blocks the
  // whole shell so the user only ever sees the change-password screen.
  if (mustChangePassword) return <ForcePasswordChange />;
  // Multi-company (DESIGN.md §6): 0 accessible brands -> no access screen;
  // >=2 with none chosen yet this session -> explicit company selection
  // before the shell. 1 accessible brand needs neither — straight in.
  if (accessibleBrands.length === 0) return <NoCompanyAccess />;
  if (companySelectionRequired) return <CompanySelection />;
  return children;
}

export default RequireStaff;
