// Small inline-SVG icon set for the auth screens (login, company picker,
// no-access, forced password change). Same convention as layout/NavIcon.jsx
// — a flat PATHS lookup, decorative by default (aria-hidden), stroke-based
// so it inherits color from CSS (currentColor).
const PATHS = {
  shieldLock: 'M12 3l8 3v6c0 5-3.4 8.4-8 9-4.6-.6-8-4-8-9V6zM12 11v3M9.5 13a2.5 2.5 0 015 0v1.2a1 1 0 01-1 1h-3a1 1 0 01-1-1z',
  mail: 'M4 5h16a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1zM3.5 6.5l8.5 6 8.5-6',
  lock: 'M6 11V8a6 6 0 0112 0v3M5 11h14a1 1 0 011 1v8a1 1 0 01-1 1H5a1 1 0 01-1-1v-8a1 1 0 011-1z',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7zM12 15a3 3 0 100-6 3 3 0 000 6z',
  eyeOff: 'M3 3l18 18M10.6 10.6a3 3 0 004.2 4.2M9.9 5.1A10.4 10.4 0 0112 5c6.4 0 10 7 10 7a17.9 17.9 0 01-4 5.1M6.1 6.1A17.6 17.6 0 002 12s3.6 7 10 7a9.9 9.9 0 004-.8',
  userX: 'M9 20v-2a4 4 0 014-4h1M5 21v-2a4 4 0 014-4h.5M9 11a4 4 0 100-8 4 4 0 000 8zM17 8l4 4M21 8l-4 4',
  key: 'M15 7a4 4 0 11-4 4M11 11L3 19v2h2l2-2h2v-2h2l1.5-1.5M15 7l2-2m0 0l2-2m-2 2l2 2m-2-2l-2-2',
  logout: 'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9',
};

export function AuthIcon({ name, className = 'auth-icon' }) {
  const d = PATHS[name] || PATHS.shieldLock;
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={d} />
    </svg>
  );
}

export default AuthIcon;
