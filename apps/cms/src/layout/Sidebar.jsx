import { NavLink } from 'react-router-dom';
import { NAV_SECTIONS } from './navigation.js';
import { NavIcon } from './NavIcon.jsx';
import { useAuth } from '../auth/useAuth.js';
import { useCompany } from '../company/useCompany.js';
import { CompanySwitcher } from '../company/CompanySwitcher.jsx';
import { BRAND_ICONS } from '../company/brandIcons.js';
import { BrandMark } from '../company/BrandMark.jsx';
import './Sidebar.css';

export function Sidebar({ open, onNavigate, showNav = true }) {
  const { hasPermission } = useAuth();
  // Multi-company (DESIGN.md §6) — "the sidebar CG mark + CORE GROUP text
  // become brand.icon_svg + brand.display_name". Falls back to the generic
  // CORE GROUP mark before a company has resolved (first paint) or for any
  // brand without an icon_svg configured yet.
  const { currentBrand } = useCompany();
  const brandName = currentBrand?.name || 'CORE GROUP';
  // Prefer the real, compiled JSX logo for a known launch brand
  // (assets/icons/) over the DB-configured raw SVG string — no
  // dangerouslySetInnerHTML needed for either Corcotton or Corznix.
  const BrandIcon = currentBrand ? BRAND_ICONS[currentBrand.slug] : null;

  return (
    <nav className={`sidebar${open ? ' sidebar--open' : ''}`} aria-label="Primary">
      <div className="sidebar__brand">
        {BrandIcon ? (
          <span className="sidebar__brand-mark sidebar__brand-mark--svg"><BrandIcon /></span>
        ) : currentBrand?.iconSvg ? (
          <span className="sidebar__brand-mark sidebar__brand-mark--svg" dangerouslySetInnerHTML={{ __html: currentBrand.iconSvg }} />
        ) : (
          <span className="sidebar__brand-mark">{brandName.slice(0, 2).toUpperCase()}</span>
        )}
        <span className="sidebar__brand-text">{brandName}</span>
        <CompanySwitcher />
      </div>
      <div className="sidebar__scroll">
        {!showNav && (
          <p className="sidebar__section-label" style={{ padding: '0 16px' }}>Coming soon — nothing to manage here yet.</p>
        )}
        {showNav && NAV_SECTIONS.map((section) => {
          const visibleItems = section.items.filter(
            (item) => !item.permission || hasPermission(item.permission)
          );
          if (visibleItems.length === 0) return null;
          return (
            <div key={section.id} className="sidebar__section">
              {section.label && <p className="sidebar__section-label">{section.label}</p>}
              <ul>
                {visibleItems.map((item) => (
                  <li key={item.to}>
                    {item.status === 'active' ? (
                      <NavLink
                        to={item.to}
                        end={item.to === '/'}
                        className={({ isActive }) => `sidebar__link${isActive ? ' sidebar__link--active' : ''}`}
                        onClick={onNavigate}
                      >
                        <NavIcon name={item.icon} />
                        <span className="sidebar__link-label">{item.label}</span>
                      </NavLink>
                    ) : (
                      <span className="sidebar__link sidebar__link--planned" aria-disabled="true" title="Coming in a later wave">
                        <NavIcon name={item.icon} />
                        <span className="sidebar__link-label">{item.label}</span>
                        <span className="sidebar__badge">soon</span>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
      {hasPermission('staff.manage') && currentBrand && (
        <NavLink to="/settings" className="sidebar__footer" onClick={onNavigate}>
          <span className="sidebar__footer-mark" aria-hidden="true"><BrandMark brand={currentBrand} /></span>
          <span className="sidebar__link-label">Your Company</span>
          <NavIcon name="chevronRight" className="sidebar__footer-chevron" />
        </NavLink>
      )}
    </nav>
  );
}

export default Sidebar;
