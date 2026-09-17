// Small inline-SVG icon set for the sidebar. Keys match the `icon` field
// already declared in navigation.js — this only renders what was there,
// it does not change any navigation destination. Decorative by default
// (aria-hidden); the adjacent text label is the accessible name.
const PATHS = {
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  tag: 'M4 13l7-7 9 9-7 7zM8.5 8.5h.01',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17l9 5 9-5',
  ruler: 'M3 8l13 13 5-5L8 3zM8 8l2 2M12 6l2 2M16 10l2 2',
  box: 'M21 8l-9-5-9 5 9 5zM3 8v8l9 5 9-5V8M12 13v8',
  cart: 'M3 4h2l2.4 12.3a2 2 0 002 1.7h7.7a2 2 0 002-1.6L21 8H6M9 21h.01M18 21h.01',
  truck: 'M3 6h11v9H3zM14 9h4l3 3v3h-7M6.5 18.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM17.5 18.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z',
  users: 'M16 20v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 10a4 4 0 100-8 4 4 0 000 8zM22 20v-2a4 4 0 00-3-3.9M16 3.1A4 4 0 0116 11',
  megaphone: 'M3 11v2a1 1 0 001 1h2l4 4V6L6 10H4a1 1 0 00-1 1zM14 8a4 4 0 010 8M17 5a8 8 0 010 14',
  doc: 'M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8zM14 3v5h5M9 13h6M9 17h6',
  star: 'M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 21l1.1-6.5L2.6 9.8l6.5-.9z',
  image: 'M3 4h18v16H3zM3 15l5-5 4 4 3-3 6 6M8.5 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z',
  menu: 'M3 6h18M3 12h18M3 18h18',
  cog: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-2.7.6 1.6 1.6 0 00-1.1 1.5V22a2 2 0 01-4 0v-.1A1.6 1.6 0 008 20.3a1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00.6-2.7 1.6 1.6 0 00-1.5-1.1H2a2 2 0 010-4h.1A1.6 1.6 0 003.7 8a1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H8a1.6 1.6 0 001-1.5V2a2 2 0 014 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V8a1.6 1.6 0 001.5 1H22a2 2 0 010 4h-.1a1.6 1.6 0 00-1.5 1z',
  shield: 'M12 3l8 3v6c0 5-3.4 8.4-8 9-4.6-.6-8-4-8-9V6z',
  building: 'M4 21V5a1 1 0 011-1h9a1 1 0 011 1v16M15 21h5V11a1 1 0 00-1-1h-4M8 8h1M8 12h1M8 16h1M11.5 8h1M11.5 12h1M11.5 16h1',
  clock: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 6v6l4 2',
  chevronRight: 'M9 6l6 6-6 6',
  barChart: 'M4 20V10M12 20V4M20 20v-7',
};

export function NavIcon({ name, className = 'nav-icon' }) {
  const d = PATHS[name] || PATHS.grid;
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={d} />
    </svg>
  );
}

export default NavIcon;
