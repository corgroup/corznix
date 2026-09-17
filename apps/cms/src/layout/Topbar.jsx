import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/useAuth.js';
import { GlobalSearch } from './GlobalSearch.jsx';
import { NotificationBell } from './NotificationBell.jsx';
import './Topbar.css';

function initials(staff) {
  return `${(staff?.firstName || '?')[0] || ''}${(staff?.lastName || '')[0] || ''}`.toUpperCase();
}

function roleLabel(role) {
  return String(role || '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

export function Topbar({ onToggleSidebar }) {
  const { staff, permissions, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const menuRef = useRef(null);

  const canSupport = permissions.includes('support.read');
  const canStaff = permissions.includes('staff.read');

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onClick = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [menuOpen]);

  const handleLogout = async () => {
    setBusy(true);
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <header className="topbar">
      <button type="button" className="topbar__menu-btn" onClick={onToggleSidebar} aria-label="Toggle navigation">
        <span />
        <span />
        <span />
      </button>

      <GlobalSearch />

      <div className="topbar__right">
        <NotificationBell />
        {canSupport && (
          <Link to="/support" className="topbar__icon-btn" title="Help &amp; support" aria-label="Help and support">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M9.2 9a2.8 2.8 0 015.5.8c0 1.9-2.8 2.4-2.8 4" />
              <path d="M12 17.5h.01" />
            </svg>
          </Link>
        )}

        <div className="topbar__account" ref={menuRef}>
          <button
            type="button"
            className="topbar__account-btn"
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <span className="topbar__avatar" aria-hidden="true">{initials(staff)}</span>
            <span className="topbar__account-meta">
              <span className="topbar__account-name">{staff?.firstName} {staff?.lastName}</span>
              <span className="topbar__account-role">{roleLabel(staff?.role)}</span>
            </span>
            <svg className="topbar__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          {menuOpen && (
            <div className="topbar__dropdown" role="menu">
              <div className="topbar__dropdown-head">
                <p className="topbar__dropdown-name">{staff?.firstName} {staff?.lastName}</p>
                <p className="topbar__dropdown-email">{staff?.email}</p>
                <p className="topbar__dropdown-role">{roleLabel(staff?.role)}</p>
              </div>
              {canStaff && (
                <Link to="/staff" className="topbar__dropdown-item" role="menuitem" onClick={() => setMenuOpen(false)}>
                  Staff &amp; access
                </Link>
              )}
              <button type="button" className="topbar__dropdown-item" onClick={handleLogout} disabled={busy} role="menuitem">
                {busy ? 'Signing out…' : 'Sign out'}
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

export default Topbar;
