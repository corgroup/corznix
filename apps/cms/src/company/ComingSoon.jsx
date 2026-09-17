import { createPortal } from 'react-dom';
import { useCompany } from './useCompany.js';
import { BrandMark } from './BrandMark.jsx';
import { CompanyMenu } from './CompanyMenu.jsx';
import { useFloatingMenu } from '../hooks/useFloatingMenu.js';
import { NavIcon } from '../layout/NavIcon.jsx';
import { CorznixWordmark } from '../assets/icons/index.js';
import './ComingSoon.css';

// Full wordmark (text logo) where one exists for the brand — bigger and
// more presence-appropriate for this full-page placeholder than the
// compact square BrandMark used in the sidebar/switcher.
const BRAND_WORDMARKS = { corznix: CorznixWordmark };

// Whole-CMS placeholder for a company with no live storefront yet
// (`brand.storefrontUrl` unset). Rendered by AdminLayout INSTEAD OF the
// routed <Outlet> — no page for this company ever mounts, so there is no
// code path left that could show another company's products, categories,
// orders, or any other data under the wrong brand.
export function ComingSoon({ brand }) {
  const { accessibleBrands, currentBrand, switchCompany } = useCompany();
  const { open: menuOpen, style: menuStyle, triggerRef, floatingRef, triggerHandlers, floatingHandlers, close: closeMenu } = useFloatingMenu({
    placement: 'bottom-start',
    gap: 8,
    maxHeight: 380,
  });
  const Wordmark = BRAND_WORDMARKS[brand.slug];

  const pick = async (brandId) => {
    closeMenu();
    if (brandId !== currentBrand?.id) {
      try { await switchCompany(brandId); } catch { /* CompanyProvider surfaces the error */ }
    }
  };

  return (
    <div className="coming-soon">
      <div className="coming-soon__hero">
        <span className="coming-soon__ring" aria-hidden="true" />
        <span className="coming-soon__float coming-soon__float--top" aria-hidden="true"><NavIcon name="building" /></span>
        <span className="coming-soon__float coming-soon__float--left" aria-hidden="true"><NavIcon name="barChart" /></span>
        <span className="coming-soon__float coming-soon__float--right" aria-hidden="true"><NavIcon name="doc" /></span>
        {Wordmark
          ? <span className="coming-soon__wordmark" aria-hidden="true"><Wordmark /></span>
          : <span className="coming-soon__mark" aria-hidden="true"><BrandMark brand={brand} /></span>}
      </div>

      <h1>{brand.name} CMS — coming soon</h1>
      <p>
        {brand.name}&rsquo;s dashboard, catalog, and reports will light up once its storefront is live.
        Use the switcher above to go back to another company.
      </p>

      <span className="coming-soon__pill"><NavIcon name="clock" /> Storefront not live yet</span>

      {accessibleBrands.length > 1 && (
        <div className="coming-soon__switch">
          <button
            type="button"
            ref={triggerRef}
            className="coming-soon__switch-btn"
            onClick={triggerHandlers.onClick}
            onMouseEnter={triggerHandlers.onMouseEnter}
            onMouseLeave={triggerHandlers.onMouseLeave}
            aria-expanded={menuOpen}
            aria-haspopup="listbox"
          >
            <NavIcon name="building" /> Switch company
          </button>
          {menuOpen && createPortal(
            <div
              ref={floatingRef}
              className="coming-soon__switch-menu"
              style={menuStyle}
              onMouseEnter={floatingHandlers.onMouseEnter}
              onMouseLeave={floatingHandlers.onMouseLeave}
            >
              <CompanyMenu accessibleBrands={accessibleBrands} currentBrand={currentBrand} onPick={pick} />
            </div>,
            document.body
          )}
        </div>
      )}

      <div className="coming-soon__footer">
        <span className="coming-soon__rule" aria-hidden="true" />
        <span className="coming-soon__footer-label">Built for what&rsquo;s next</span>
        <span className="coming-soon__rule" aria-hidden="true" />
      </div>
      <p className="coming-soon__footer-tagline">Same platform. More possibilities.</p>
    </div>
  );
}

export default ComingSoon;
