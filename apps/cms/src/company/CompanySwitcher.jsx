import { createPortal } from 'react-dom';
import { useCompany } from './useCompany.js';
import { CompanyMenu } from './CompanyMenu.jsx';
import { useFloatingMenu } from '../hooks/useFloatingMenu.js';
import './CompanySwitcher.css';

// Sidebar header company switcher (implementation/multi-company/DESIGN.md
// §6). Renders nothing when the staff member only has one accessible
// company — there's nothing to switch between, and the plain brand mark in
// Sidebar.jsx already shows their one company.
//
// The menu itself is a portaled, Floating-UI-positioned popover (see
// useFloatingMenu) rather than a CSS-absolute child of the sidebar: the
// sidebar is a fixed-width, scrollable column, so anything anchored inside
// it either gets clipped by that scroll area or has to grow the sidebar to
// fit — a `position: fixed` panel under document.body avoids both.
export function CompanySwitcher() {
  const { accessibleBrands, currentBrand, hasMultipleCompanies, switching, switchCompany } = useCompany();
  const { open, style, triggerRef, floatingRef, triggerHandlers, floatingHandlers, close } = useFloatingMenu({
    placement: 'bottom-start',
    gap: 8,
    maxHeight: 420,
  });

  if (!hasMultipleCompanies) return null;

  const pick = async (brandId) => {
    close();
    if (brandId !== currentBrand?.id) {
      try {
        await switchCompany(brandId);
      } catch {
        /* CompanyProvider already surfaces switchError; nothing more to do here */
      }
    }
  };

  return (
    <div className="company-switcher">
      <button
        type="button"
        ref={triggerRef}
        className="company-switcher__trigger"
        onClick={triggerHandlers.onClick}
        onMouseEnter={triggerHandlers.onMouseEnter}
        onMouseLeave={triggerHandlers.onMouseLeave}
        disabled={switching}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span className="company-switcher__caret" aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {open && createPortal(
        <div
          ref={floatingRef}
          className="company-switcher__menu"
          style={style}
          onMouseEnter={floatingHandlers.onMouseEnter}
          onMouseLeave={floatingHandlers.onMouseLeave}
        >
          <CompanyMenu accessibleBrands={accessibleBrands} currentBrand={currentBrand} onPick={pick} />
        </div>,
        document.body
      )}
    </div>
  );
}

export default CompanySwitcher;
