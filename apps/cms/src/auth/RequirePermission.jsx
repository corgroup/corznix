import { useAuth } from './useAuth.js';
import UnauthorizedPage from '../pages/UnauthorizedPage.jsx';

// Renders the Unauthorized page in place (keeps the URL) when the current
// staff role lacks `permission`. This is purely a UX affordance — the
// backend returns 403 for the same call no matter what renders here.
export function RequirePermission({ permission, children }) {
  const { hasPermission } = useAuth();
  if (!hasPermission(permission)) {
    return <UnauthorizedPage requiredPermission={permission} />;
  }
  return children;
}

export default RequirePermission;
