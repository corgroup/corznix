import { useCallback, useEffect, useMemo, useState } from 'react';
import { adminApi } from '../api/adminApi.js';
import { setCurrentBrandId } from '../api/brandContext.js';
import { useAuth } from '../auth/useAuth.js';
import { CompanyContext } from './CompanyContext.js';

// Per-brand favicons — the real icon marks (not the DB `icon_svg`, which a
// SUPER_ADMIN could one day edit to something impractical at 16px; a
// favicon is worth pinning to a real static asset). `public/favicon.svg`
// is the parent COR-GROUP mark (deliberately company-agnostic) — it's the
// static <link> in index.html for true first paint, and stays the fallback
// here for the pre-company-resolved state and any brand without an entry.
const FAVICONS = {
  corcotton: '/favicon-corcotton.svg',
  corznix: '/favicon-corznix.svg',
};
const DEFAULT_FAVICON = '/favicon.svg';

// Multi-company CMS (implementation/multi-company/DESIGN.md §6). Sits
// inside <AuthProvider> — the company fields (accessibleBrands, currentBrand,
// companySelectionRequired) are part of the same /me response AuthProvider
// already fetches, so this layer adds no extra network round trip. It owns:
//   - switchCompany(brandId): PUT the switcher, then refetch /me so staff +
//     company state land in the same place, atomically.
//   - keeping `apiClient`'s `x-brand-id` header (api/brandContext.js) in
//     sync with the resolved current company.
//   - applying `brand.theme` (brands.theme_json) as CSS custom properties,
//     so a themed brand can override the accent without any component
//     needing to know multi-company exists.
//   - `companyKey` — pass as the `key` on the routed subtree (AdminLayout's
//     <Outlet>) so switching companies remounts every page under the new
//     brand instead of leaving stale, wrong-company data on screen.
export function CompanyProvider({ children }) {
  const auth = useAuth();
  const { isAuthenticated, accessibleBrands, currentBrand, companySelectionRequired, reload } = auth;
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState('');

  useEffect(() => {
    setCurrentBrandId(isAuthenticated ? currentBrand?.id : null);
  }, [isAuthenticated, currentBrand]);

  useEffect(() => {
    let link = document.querySelector('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.type = 'image/svg+xml';
    link.href = (currentBrand && FAVICONS[currentBrand.slug]) || DEFAULT_FAVICON;
  }, [currentBrand]);

  useEffect(() => {
    const root = document.documentElement;
    const theme = currentBrand?.theme;
    // Only ever set keys the brand actually configured — never clears an
    // unrelated CSS variable, and a brand with no theme_json changes
    // nothing (both seeded brands today: Cor-Cotton, Cor-Znix).
    if (theme && typeof theme === 'object') {
      for (const [key, val] of Object.entries(theme)) {
        if (typeof val === 'string') root.style.setProperty(`--brand-${key}`, val);
      }
    }
  }, [currentBrand]);

  const switchCompany = useCallback(async (brandId) => {
    if (!brandId || brandId === currentBrand?.id) return;
    setSwitching(true);
    setSwitchError('');
    try {
      await adminApi.switchBrand(brandId);
      // resolveBrandContext resolves req.brandId from `x-brand-id` header ||
      // session.current_brand_id || default — the header wins on purpose
      // (a future non-interactive caller can pin a brand per request). That
      // means the very next request — this reload's own GET /me — would
      // otherwise still carry the STALE header (the effect below only fires
      // after `currentBrand` state updates, which hasn't happened yet) and
      // read back the brand we just switched away from. Set it synchronously
      // here, ahead of the effect, so reload() sees the new brand immediately.
      setCurrentBrandId(brandId);
      await reload();
    } catch (err) {
      setSwitchError(err?.message || 'Could not switch company.');
      throw err;
    } finally {
      setSwitching(false);
    }
  }, [currentBrand, reload]);

  const value = useMemo(() => ({
    accessibleBrands,
    currentBrand,
    companySelectionRequired,
    hasMultipleCompanies: accessibleBrands.length > 1,
    companyKey: currentBrand?.id || 'no-company',
    switching,
    switchError,
    switchCompany,
  }), [accessibleBrands, currentBrand, companySelectionRequired, switching, switchError, switchCompany]);

  return <CompanyContext.Provider value={value}>{children}</CompanyContext.Provider>;
}

export default CompanyProvider;
