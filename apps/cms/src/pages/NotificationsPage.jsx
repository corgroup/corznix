import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageShell } from '../layout/PageShell.jsx';
import { Button } from '../components/ui/Button.jsx';
import { LoadingState } from '../components/feedback/LoadingState.jsx';
import { ErrorState } from '../components/feedback/ErrorState.jsx';
import { adminApi } from '../api/adminApi.js';
import { formatDateTime } from '../utils/format.js';
import './NotificationsPage.css';

const FILTERS = [
  ['', 'All'],
  ['ORDER', 'Orders'],
  ['RETURN', 'Returns'],
  ['SHIPMENT', 'Shipments'],
  ['INVENTORY', 'Inventory'],
  ['SYSTEM', 'System'],
];

function feedParams(category, unreadOnly, before) {
  const params = { limit: 30 };
  if (category) params.category = category;
  if (unreadOnly) params.unread = true;
  if (before) params.before = before;
  return params;
}

export function NotificationsPage() {
  const navigate = useNavigate();
  const [category, setCategory] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState({ status: 'loading', items: [], unreadCount: 0, cursor: null });

  useEffect(() => {
    let cancelled = false;
    adminApi.notifications.feed(feedParams(category, unreadOnly)).then(
      (d) => { if (!cancelled) setState({ status: 'ready', items: d.items || [], unreadCount: d.unreadCount ?? 0, cursor: d.nextCursor || null }); },
      () => { if (!cancelled) setState((s) => ({ ...s, status: 'error' })); },
    );
    return () => { cancelled = true; };
  }, [category, unreadOnly, nonce]);

  const loadMore = () => {
    if (!state.cursor) return;
    adminApi.notifications.feed(feedParams(category, unreadOnly, state.cursor)).then((d) => {
      setState((s) => ({ ...s, items: [...s.items, ...(d.items || [])], cursor: d.nextCursor || null }));
    }).catch(() => {});
  };

  const markAll = () => {
    adminApi.notifications.markAllRead().then(() => setNonce((n) => n + 1)).catch(() => {});
  };

  const open = (item) => {
    if (!item.read) {
      adminApi.notifications.markRead([item.id]).catch(() => {});
      setState((s) => ({
        ...s,
        unreadCount: Math.max(0, s.unreadCount - 1),
        items: s.items.map((i) => (i.id === item.id ? { ...i, read: true } : i)),
      }));
    }
    if (item.link) navigate(item.link);
  };

  return (
    <PageShell
      title="Notifications"
      description="Operational activity across orders, returns, shipments and inventory."
      actions={state.unreadCount > 0 && <Button variant="secondary" onClick={markAll}>Mark all read</Button>}
    >
      <div className="notif-page__toolbar">
        <div className="notif-page__filters">
          {FILTERS.map(([value, label]) => (
            <button
              key={value || 'all'}
              type="button"
              className={`chip${category === value ? ' chip--active' : ''}`}
              onClick={() => setCategory(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="notif-page__unread">
          <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
          Unread only
        </label>
      </div>

      {state.status === 'loading' && <LoadingState label="Loading activity…" />}
      {state.status === 'error' && <ErrorState message="Could not load notifications." onRetry={() => setNonce((n) => n + 1)} />}

      {state.status === 'ready' && (
        <>
          {state.items.length === 0 ? (
            <p className="notif-page__empty">Nothing here yet.</p>
          ) : (
            <ul className="notif-page__list">
              {state.items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`notif-page__row${item.read ? '' : ' notif-page__row--unread'}`}
                    onClick={() => open(item)}
                  >
                    <span className={`notif-page__sev notif-page__sev--${item.severity.toLowerCase()}`} aria-hidden="true" />
                    <span className="notif-page__main">
                      <span className="notif-page__row-title">{item.title}</span>
                      {item.body && <span className="notif-page__row-body">{item.body}</span>}
                    </span>
                    <span className="notif-page__meta">
                      <span className="notif-page__cat">{item.category}</span>
                      <span className="notif-page__time">{formatDateTime(item.createdAt)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {state.cursor && (
            <div className="notif-page__more">
              <Button variant="secondary" onClick={loadMore}>Load more</Button>
            </div>
          )}
        </>
      )}
    </PageShell>
  );
}

export default NotificationsPage;
