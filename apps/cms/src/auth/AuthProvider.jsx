import { useCallback, useEffect, useMemo, useState } from 'react';
import { adminApi } from '../api/adminApi.js';
import { AuthContext, AUTH_STATES } from './AuthContext.js';

const EMPTY_ME = { accessibleBrands: [], currentBrand: null, companySelectionRequired: false };

// Session state is server-authoritative. On boot the CMS asks
// GET /api/v1/admin/me — a valid HttpOnly staff cookie resolves to a staff
// profile, anything else resolves to GUEST (never a hang, never a throw
// past here). Protected UI is never rendered before this resolves
// (Wave 8A brief §38).
//
// The same /me response also carries the multi-company fields
// (implementation/multi-company/DESIGN.md §6) — accessibleBrands,
// currentBrand, companySelectionRequired — so `CompanyProvider` (which
// wraps this one) reads them straight off this context instead of making
// its own redundant /me call.
export function AuthProvider({ children }) {
  const [staff, setStaff] = useState(null);
  const [company, setCompany] = useState(EMPTY_ME);
  const [authState, setAuthState] = useState(AUTH_STATES.LOADING);

  const applyMeResult = useCallback((result) => {
    if (result?.staff) {
      setStaff(result.staff);
      setCompany({
        accessibleBrands: result.accessibleBrands || [],
        currentBrand: result.currentBrand || null,
        companySelectionRequired: Boolean(result.companySelectionRequired),
      });
      setAuthState(AUTH_STATES.AUTHENTICATED);
      return result.staff;
    }
    setStaff(null);
    setCompany(EMPTY_ME);
    setAuthState(AUTH_STATES.GUEST);
    return null;
  }, []);

  const loadSession = useCallback(async () => {
    const result = await adminApi.me().catch(() => null);
    return applyMeResult(result);
  }, [applyMeResult]);

  // Single fetch on mount — loadSession is also exposed as `reload` for the
  // switcher and any other caller that needs a fresh /me after a mutation.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await adminApi.me().catch(() => null);
      if (!cancelled) applyMeResult(result);
    })();
    return () => {
      cancelled = true;
    };
  }, [applyMeResult]);

  const login = useCallback(async (email, password) => {
    // Login sets the session cookie server-side; the response body only
    // carries `staff`, not the company fields, so resolve full state (staff
    // + accessibleBrands + currentBrand together, atomically) via the same
    // /me path everything else uses — never a partial "authenticated but no
    // company data yet" state a route guard could observe.
    await adminApi.login(email, password);
    const staff = await loadSession();
    if (!staff) throw new Error('Signed in but the session could not be confirmed. Please try again.');
    return staff;
  }, [loadSession]);

  const logout = useCallback(async () => {
    // Revoke server authority first, then drop local state unconditionally
    // so a network blip can't leave the UI stuck "signed in".
    try {
      await adminApi.logout();
    } catch {
      /* fall through */
    }
    setStaff(null);
    setCompany(EMPTY_ME);
    setAuthState(AUTH_STATES.GUEST);
  }, []);

  const changePassword = useCallback(async (currentPassword, newPassword) => {
    const result = await adminApi.changePassword(currentPassword, newPassword);
    setStaff(result.staff);
    setAuthState(AUTH_STATES.AUTHENTICATED);
    return result.staff;
  }, []);

  const value = useMemo(() => {
    const permissions = staff?.permissions ?? [];
    return {
      staff,
      authState,
      loading: authState === AUTH_STATES.LOADING,
      isAuthenticated: authState === AUTH_STATES.AUTHENTICATED,
      mustChangePassword: Boolean(staff?.mustChangePassword),
      permissions,
      hasPermission: (permission) => permissions.includes(permission),
      // Multi-company (DESIGN.md §6) — see CompanyProvider for the
      // consumer-facing shape (switchCompany, companyKey, branding).
      accessibleBrands: company.accessibleBrands,
      currentBrand: company.currentBrand,
      companySelectionRequired: company.companySelectionRequired,
      login,
      logout,
      changePassword,
      reload: loadSession,
    };
  }, [staff, company, authState, login, logout, changePassword, loadSession]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export default AuthProvider;
