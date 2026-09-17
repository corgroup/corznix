import { BRAND_ICONS } from './brandIcons.js';

// Shared brand mark — real hardcoded icon (BRAND_ICONS) first, then the
// DB-configured icon_svg, then initials. Used by CompanySelection and
// CompanySwitcher so a company's logo looks the same everywhere it appears.
export function BrandMark({ brand }) {
  const Icon = BRAND_ICONS[brand.slug];
  if (Icon) return <Icon />;
  if (brand.iconSvg) return <span dangerouslySetInnerHTML={{ __html: brand.iconSvg }} />;
  return brand.name?.slice(0, 2).toUpperCase();
}

export default BrandMark;
