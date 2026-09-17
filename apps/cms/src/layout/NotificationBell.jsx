import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminApi } from '../api/adminApi.js';
import { playNotificationSound, setSoundEnabled, soundEnabled, unlockNotificationSound } from './notificationSound.js';
import './NotificationBell.css';

// Checked every 15 s so a new order is heard promptly (a background tab is
// throttled by the browser to about once a minute).
const POLL_MS = 15_000;
const CAT_ICON = {
  ORDER: 'M6 2h9l5 5v13a1 1 0 01-1 1H6a1 1 0 01-1-1V3a1 1 0 011-1z',
  RETURN: 'M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-3',
  SHIPMENT: 'M3 7h11v10H3zM14 10h4l3 3v4h-7M6.5 20a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM17.5 20a1.5 1.5 0 100-3 1.5 1.5 0 000 3z',
  INVENTORY: 'M3 7l9-4 9 4-9 4-9-4zM3 7v10l9 4 9-4V7M12 11v10',
  SYSTEM: 'M12 8v5M12 16h.01M12 3l9 16H3z',
};

// Which sound a new notification makes: a new order, a new message (team chat
// or a customer's support ticket/reply), or a service alert. Everything else
// (returns, careers, allocation…) arrives silently.
function soundFor(item) {
  if (item.category === 'ORDER' && (item.eventKey === 'ORDER_PLACED' || item.eventKey === 'OWNER_DELIVERY_ORDER')) return 'order';
  if (item.category === 'MESSAGE' || item.category === 'MENTION' || item.category === 'SUPPORT') return 'message';
  if (item.category === 'SYSTEM') return 'service';
  return null;
}
const SOUND_PRIORITY = ['order', 'message', 'service'];
const timeOf = (item) => new Date(item.createdAt).getTime();

function relTime(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604_800) return `${Math.floor(s / 86_400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function NotificationBell() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [feed, setFeed] = useState({ status: 'idle', items: [] });
  const [sound, setSound] = useState(soundEnabled);
  const rootRef = useRef(null);
  // Newest notification time already known. Null until the first check, so
  // what was waiting when the CMS opened makes no sound.
  const newestSeen = useRef(null);

  const poll = useCallback(() => {
    adminApi.notifications.feed({ limit: 20 })
      .then((d) => {
        const items = d?.items || [];
        setUnread(Number(d?.unreadCount || 0));
        setFeed((f) => (f.status === 'ready' ? { status: 'ready', items: items.slice(0, 12) } : f));

        const newest = items.reduce((m, i) => Math.max(m, timeOf(i) || 0), 0);
        if (newestSeen.current === null) { newestSeen.current = newest; return; }
        const fresh = items.filter((i) => !i.read && timeOf(i) > newestSeen.current);
        newestSeen.current = Math.max(newestSeen.current, newest);
        if (!fresh.length || !soundEnabled()) return;

        const kind = SOUND_PRIORITY.find((k) => fresh.some((i) => soundFor(i) === k));
        if (kind) playNotificationSound(kind, { onceFor: fresh.find((i) => soundFor(i) === kind).id });
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    poll();
    const t = setInterval(poll, POLL_MS);
    return () => clearInterval(t);
  }, [poll]);

  // Browsers allow audio only after the page has had a click or key press.
  useEffect(() => {
    const unlock = () => {
      unlockNotificationSound();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return unlock;
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onClick = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) {
      setFeed({ status: 'loading', items: [] });
      adminApi.notifications.feed({ limit: 12 }).then(
        (d) => setFeed({ status: 'ready', items: d?.items || [] }),
        () => setFeed({ status: 'error', items: [] }),
      );
    }
  };

  const toggleSound = () => {
    const next = !sound;
    setSoundEnabled(next);
    setSound(next);
    // Turning it on plays the message sound once, so staff hear what to expect.
    if (next) playNotificationSound('message');
  };

  const markAll = () => {
    adminApi.notifications.markAllRead().then(() => {
      setUnread(0);
      setFeed((f) => ({ ...f, items: f.items.map((i) => ({ ...i, read: true })) }));
    }).catch(() => {});
  };

  const openItem = (item) => {
    setOpen(false);
    if (!item.read) {
      adminApi.notifications.markRead([item.id]).then((d) => {
        setUnread(Number(d?.unreadCount ?? Math.max(0, unread - 1)));
      }).catch(() => {});
    }
    if (item.link) navigate(item.link);
  };

  return (
    <div className="notif" ref={rootRef}>
      <button
        type="button"
        className="topbar__icon-btn notif__btn"
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={toggle}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a2 2 0 01-3.4 0" />
        </svg>
        {unread > 0 && <span className="notif__badge">{unread > 99 ? '99+' : unread}</span>}
      </button>

      {open && (
        <div className="notif__panel" role="dialog" aria-label="Notifications">
          <header className="notif__head">
            <span className="notif__title">Notifications</span>
            <span className="notif__head-actions">
              <button
                type="button"
                className="notif__sound"
                aria-pressed={sound}
                title={sound ? 'Sound plays for new orders, messages and service alerts' : 'Notifications arrive silently'}
                onClick={toggleSound}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M11 5L6 9H3v6h3l5 4V5z" />
                  {sound ? <path d="M15.5 8.5a5 5 0 010 7M18.5 5.5a9 9 0 010 13" /> : <path d="M22 9l-6 6M16 9l6 6" />}
                </svg>
                {sound ? 'Sound on' : 'Sound off'}
              </button>
              {unread > 0 && (
                <button type="button" className="notif__link" onClick={markAll}>Mark all read</button>
              )}
            </span>
          </header>

          <div className="notif__list">
            {feed.status === 'loading' && <p className="notif__empty">Loading…</p>}
            {feed.status === 'error' && <p className="notif__empty">Could not load notifications.</p>}
            {feed.status === 'ready' && feed.items.length === 0 && (
              <p className="notif__empty">You&rsquo;re all caught up.</p>
            )}
            {feed.items.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`notif__item${item.read ? '' : ' notif__item--unread'}`}
                onClick={() => openItem(item)}
              >
                <span className={`notif__icon notif__icon--${item.severity.toLowerCase()}`} aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d={CAT_ICON[item.category] || CAT_ICON.SYSTEM} />
                  </svg>
                </span>
                <span className="notif__body">
                  <span className="notif__item-title">{item.title}</span>
                  {item.body && <span className="notif__item-detail">{item.body}</span>}
                  <span className="notif__item-time">{relTime(item.createdAt)}</span>
                </span>
                {!item.read && <span className="notif__dot" aria-hidden="true" />}
              </button>
            ))}
          </div>

          <footer className="notif__foot">
            <button
              type="button"
              className="notif__link"
              onClick={() => { setOpen(false); navigate('/notifications'); }}
            >
              View all activity
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}

export default NotificationBell;
