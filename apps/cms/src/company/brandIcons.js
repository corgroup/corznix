import { CorcottonIcon, CorznixIcon } from '../assets/icons/index.js';

// Known-brand icon components (implementation/multi-company/DESIGN.md §6)
// — real, compiled, versioned logos for the two launch companies, keyed by
// `brands.slug`. Preferred over the DB-configured `brand.iconSvg` (raw SVG
// text rendered via dangerouslySetInnerHTML) wherever a mapping exists here.
// A brand added later through the CMS without a hardcoded component falls
// back to its own `icon_svg` (or an initials mark) — see Sidebar.jsx /
// CompanySelection.jsx, which both consult this map first.
export const BRAND_ICONS = {
  corcotton: CorcottonIcon,
  corznix: CorznixIcon,
};

export default BRAND_ICONS;
