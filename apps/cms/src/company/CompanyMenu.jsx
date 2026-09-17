import { BrandMark } from './BrandMark.jsx';
import { BRAND_TAGLINES } from './brandTaglines.js';
import './CompanyMenu.css';

// Shared company list — the actual picker UI, used both by the sidebar
// header's CompanySwitcher (a small popover) and ComingSoon's "Switch
// company" button (same list, no other way to reach the switcher from a
// company that shows no sidebar nav of its own).
export function CompanyMenu({ accessibleBrands, currentBrand, onPick }) {
  return (
    <ul className="company-menu" role="listbox">
      {accessibleBrands.map((brand) => {
        const isActive = brand.id === currentBrand?.id;
        return (
          <li key={brand.id}>
            <button
              type="button"
              role="option"
              aria-selected={isActive}
              className={`company-menu__item${isActive ? ' company-menu__item--active' : ''}`}
              onClick={() => onPick(brand.id)}
            >
              <span className="company-menu__mark" aria-hidden="true"><BrandMark brand={brand} /></span>
              <span className="company-menu__text">
                <span className="company-menu__row">
                  <span className="company-menu__name">{brand.name}</span>
                  {!brand.storefrontUrl && <span className="company-menu__soon">Soon</span>}
                </span>
                <span className="company-menu__tagline">{BRAND_TAGLINES[brand.slug] || brand.role}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export default CompanyMenu;
