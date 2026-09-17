import { Suspense, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar.jsx';
import { Topbar } from './Topbar.jsx';
import { useCompany } from '../company/useCompany.js';
import { ComingSoon } from '../company/ComingSoon.jsx';
import { LoadingState } from '../components/feedback/LoadingState.jsx';
import './AdminLayout.css';

// Authenticated CMS shell: persistent sidebar + topbar with the content
// region rendering the matched route via <Outlet />. The sidebar collapses
// to an overlay drawer on narrow (tablet/mobile) viewports.
export function AdminLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Multi-company (DESIGN.md §6) — keying the routed subtree on the current
  // company forces every page to remount (and refetch) on switch, instead
  // of leaving stale, wrong-company data on screen. Sidebar/Topbar stay
  // mounted — they read the new company reactively via context.
  const { companyKey, currentBrand } = useCompany();
  // A company with no live storefront yet (Corznix today) gets NO routed
  // page at all — not an empty catalog, not a zeroed dashboard. This is
  // the one place that decides that, so no individual page can leak
  // another company's data under the wrong brand by omission.
  const isLive = Boolean(currentBrand?.storefrontUrl);

  return (
    <div className="admin-shell">
      <Sidebar open={sidebarOpen} onNavigate={() => setSidebarOpen(false)} showNav={isLive} />
      {sidebarOpen && <div className="admin-shell__scrim" onClick={() => setSidebarOpen(false)} aria-hidden="true" />}
      <div className="admin-shell__main">
        <Topbar onToggleSidebar={() => setSidebarOpen((v) => !v)} />
        <main className="admin-shell__content">
          {/* Pages are lazy chunks (app/router.jsx): the sidebar and topbar
              stay put while the page's chunk loads. */}
          {isLive ? (
            <Suspense fallback={<LoadingState label="Loading page…" />}>
              <Outlet key={companyKey} />
            </Suspense>
          ) : <ComingSoon brand={currentBrand} />}
        </main>
      </div>
    </div>
  );
}

export default AdminLayout;
