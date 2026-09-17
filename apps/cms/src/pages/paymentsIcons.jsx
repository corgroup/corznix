// Icons for the Payments screen. Inline SVG, currentColor, no icon font —
// each one names what it marks rather than decorating it.
const base = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' };

export const TruckIcon = ({ size = 20 }) => (
  <svg width={size} height={size} {...base} aria-hidden="true">
    <path d="M3 7h11v9H3zM14 10h4l3 3v3h-7z" /><circle cx="7" cy="18" r="1.6" /><circle cx="17.5" cy="18" r="1.6" />
  </svg>
);

export const CardIcon = ({ size = 20 }) => (
  <svg width={size} height={size} {...base} aria-hidden="true">
    <rect x="2.5" y="5.5" width="19" height="13" rx="2.5" /><path d="M2.5 10h19M6 14.5h3" />
  </svg>
);

export const LayersIcon = ({ size = 20 }) => (
  <svg width={size} height={size} {...base} aria-hidden="true">
    <path d="M12 3l9 4.5-9 4.5-9-4.5L12 3zM3 12l9 4.5L21 12M3 16.5L12 21l9-4.5" />
  </svg>
);

export const ShieldIcon = ({ size = 20 }) => (
  <svg width={size} height={size} {...base} aria-hidden="true">
    <path d="M12 3l7 3v5.5c0 4.2-2.9 7.6-7 9.5-4.1-1.9-7-5.3-7-9.5V6l7-3z" /><path d="M9.5 12l1.8 1.8 3.4-3.6" />
  </svg>
);

export const PinIcon = ({ size = 20 }) => (
  <svg width={size} height={size} {...base} aria-hidden="true">
    <path d="M12 21s7-5.6 7-11a7 7 0 10-14 0c0 5.4 7 11 7 11z" /><circle cx="12" cy="10" r="2.5" />
  </svg>
);

export const WarnIcon = ({ size = 18 }) => (
  <svg width={size} height={size} {...base} aria-hidden="true">
    <path d="M12 4.5l8.5 15h-17l8.5-15z" /><path d="M12 10v4" /><circle cx="12" cy="17" r="0.6" fill="currentColor" />
  </svg>
);

export const InfoIcon = ({ size = 18 }) => (
  <svg width={size} height={size} {...base} aria-hidden="true">
    <circle cx="12" cy="12" r="8.5" /><path d="M12 11v5" /><circle cx="12" cy="8.2" r="0.6" fill="currentColor" />
  </svg>
);

export const SearchIcon = ({ size = 16 }) => (
  <svg width={size} height={size} {...base} aria-hidden="true">
    <circle cx="11" cy="11" r="6" /><path d="M15.5 15.5L20 20" />
  </svg>
);

export const ChartIcon = ({ size = 20 }) => (
  <svg width={size} height={size} {...base} aria-hidden="true">
    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
  </svg>
);
