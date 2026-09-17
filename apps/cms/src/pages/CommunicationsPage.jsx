import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Button } from '../components/ui/Button.jsx';
import { Dialog } from '../components/ui/Dialog.jsx';
import { InlineAlert } from '../components/feedback/InlineAlert.jsx';
import { LoadingState } from '../components/feedback/LoadingState.jsx';
import { ErrorState } from '../components/feedback/ErrorState.jsx';
import { adminApi } from '../api/adminApi.js';
import { useAuth } from '../auth/useAuth.js';
import { normalizeApiError } from '../utils/errors.js';
import { formatRelative } from '../utils/format.js';
import './CommunicationsPage.css';

const TYPE_LABEL = {
  GENERAL: 'General', ORDER: 'Order Query', DELIVERY: 'Delivery', PAYMENT: 'Payment',
  RETURN: 'Return', EXCHANGE: 'Exchange', PRODUCT: 'Product Query', ACCOUNT: 'Account',
};
const STATUS_LABEL = {
  OPEN: 'Open', IN_PROGRESS: 'In progress', WAITING_CUSTOMER: 'Waiting on customer',
  WAITING_INTERNAL: 'Waiting on team', RESOLVED: 'Resolved', CLOSED: 'Closed',
};
const STATUS_OPTIONS = ['IN_PROGRESS', 'WAITING_CUSTOMER', 'WAITING_INTERNAL', 'RESOLVED', 'CLOSED'];
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
const CATEGORY_OPTIONS = ['GENERAL', 'ORDER', 'DELIVERY', 'PAYMENT', 'RETURN', 'EXCHANGE', 'PRODUCT'];

function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => (typeof window !== 'undefined' ? window.matchMedia(query).matches : false));
  useEffect(() => {
    const mql = window.matchMedia(query);
    const on = () => setMatches(mql.matches);
    mql.addEventListener('change', on);
    return () => mql.removeEventListener('change', on);
  }, [query]);
  return matches;
}

const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
const money = (minor, currency = 'INR') => {
  if (minor == null) return '—';
  try { return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(Number(minor) / 100); }
  catch { return `₹${Math.round(Number(minor) / 100)}`; }
};

// ---------------------------------------------------------------------------
// Inbox rows
// ---------------------------------------------------------------------------
function TicketRow({ t, active, onSelect }) {
  return (
    <button type="button" className={`comms-row${active ? ' comms-row--active' : ''}`} onClick={onSelect}>
      <span className="comms-avatar">{initials(t.customerName || 'Customer')}</span>
      <span className="comms-row__main">
        <span className="comms-row__top">
          <span className="comms-row__name">{t.customerName || 'Customer'}</span>
        </span>
        <span className="comms-row__subject">{t.subject}</span>
        {t.lastMessagePreview && <p className="comms-row__preview">{t.lastMessagePreview}</p>}
        <span className="comms-row__meta">
          <span className="comms-badge">{TYPE_LABEL[t.category] || t.category}</span>
          {t.orderNumber && <span className="comms-badge comms-badge--order">{t.orderNumber}</span>}
          {t.returnRequestId && <span className="comms-badge comms-badge--return">Return</span>}
          {t.priority === 'URGENT' && <span className="comms-badge comms-badge--urgent">Urgent</span>}
          {t.priority === 'HIGH' && <span className="comms-badge comms-badge--high">High</span>}
        </span>
      </span>
      <span className="comms-row__side">
        <span className="comms-row__time">{formatRelative(t.lastMessageAt || t.updatedAt)}</span>
        {t.needsReply && <span className="comms-dot" title="Customer is waiting for a reply" />}
        <span className="comms-badge">{STATUS_LABEL[t.status] || t.status}</span>
      </span>
    </button>
  );
}

function InternalRow({ c, active, onSelect }) {
  return (
    <button type="button" className={`comms-row${active ? ' comms-row--active' : ''}`} onClick={onSelect}>
      <span className="comms-avatar comms-avatar--staff">{initials(c.title)}</span>
      <span className="comms-row__main">
        <span className="comms-row__top"><span className="comms-row__name">{c.title}</span></span>
        {c.lastMessage
          ? <p className="comms-row__preview">{c.lastMessage.fromMe ? 'You: ' : ''}{c.lastMessage.preview}</p>
          : <p className="comms-row__preview">No messages yet</p>}
        <span className="comms-row__meta">
          <span className="comms-badge comms-badge--internal">{c.kind === 'GROUP' ? `Group · ${c.participantCount}` : 'Direct'}</span>
          {c.orderId && <span className="comms-badge comms-badge--order">Order-linked</span>}
        </span>
      </span>
      <span className="comms-row__side">
        <span className="comms-row__time">{formatRelative(c.lastMessageAt || c.createdAt)}</span>
        {c.unreadCount > 0 && <span className="comms-unread">{c.unreadCount}</span>}
      </span>
    </button>
  );
}

// Rail content rendered by the page (kept as a component so the mobile drawer can reuse it)
function TicketRail({ t, order, staffList, canManage, onAct }) {
  if (!t) return null;
  const o = order?.order;
  return (
    <>
      <div className="comms-rail__card">
        <h3 className="comms-rail__title">Conversation</h3>
        <dl>
          <div className="comms-rail__row"><dt>Type</dt><dd>{TYPE_LABEL[t.category] || t.category}</dd></div>
          <div className="comms-rail__row">
            <dt>Status</dt>
            <dd>{canManage
              ? (
                <select value={t.status} onChange={(e) => onAct(() => adminApi.support.status(t.id, e.target.value))}>
                  <option value={t.status}>{STATUS_LABEL[t.status]}</option>
                  {STATUS_OPTIONS.filter((s) => s !== t.status).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                </select>
              )
              : STATUS_LABEL[t.status]}
            </dd>
          </div>
          <div className="comms-rail__row">
            <dt>Priority</dt>
            <dd>{canManage
              ? (
                <select value={t.priority} onChange={(e) => onAct(() => adminApi.support.priority(t.id, e.target.value))}>
                  {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              )
              : t.priority}
            </dd>
          </div>
          <div className="comms-rail__row">
            <dt>Assigned to</dt>
            <dd>{canManage
              ? (
                <select value={t.assignedStaffId || ''} onChange={(e) => onAct(() => adminApi.support.assign(t.id, e.target.value || null, t.assignmentVersion))}>
                  <option value="">Unassigned</option>
                  {staffList.map((s) => <option key={s.id} value={s.id}>{s.name || s.email}</option>)}
                </select>
              )
              : (t.assignedStaffName || 'Unassigned')}
            </dd>
          </div>
          {t.warehouseId && (
            <div className="comms-rail__row"><dt>Warehouse</dt><dd>{o?.warehouse?.name || t.warehouseStaff?.[0]?.warehouseName || 'Linked'}</dd></div>
          )}
        </dl>
        {canManage && t.status !== 'RESOLVED' && t.status !== 'CLOSED' && (
          <Button variant="secondary" onClick={() => onAct(() => adminApi.support.status(t.id, 'RESOLVED'))} style={{ marginTop: 8 }}>Resolve conversation</Button>
        )}
        {canManage && (t.status === 'RESOLVED' || t.status === 'CLOSED') && (
          <Button variant="secondary" onClick={() => onAct(() => adminApi.support.status(t.id, 'IN_PROGRESS'))} style={{ marginTop: 8 }}>Re-open</Button>
        )}
      </div>

      <div className="comms-rail__card">
        <h3 className="comms-rail__title">Customer</h3>
        <dl>
          <div className="comms-rail__row"><dt>Name</dt><dd>{t.customer?.name || '—'}</dd></div>
          <div className="comms-rail__row"><dt>Email</dt><dd>{t.customer?.emailMasked || '—'}</dd></div>
          {t.customer?.phoneMasked && <div className="comms-rail__row"><dt>Phone</dt><dd>{t.customer.phoneMasked}</dd></div>}
          <div className="comms-rail__row"><dt>Account</dt><dd>{t.customer?.status || '—'}</dd></div>
        </dl>
        {t.customerId && <Link to={`/customers/${t.customerId}`} className="linkish comms-rail__link">View customer ↗</Link>}
      </div>

      {t.orderId && (
        <div className="comms-rail__card">
          <h3 className="comms-rail__title">Related order</h3>
          <dl>
            <div className="comms-rail__row"><dt>Order</dt><dd>{o?.orderNumber || t.context?.orderNumber || '—'}</dd></div>
            <div className="comms-rail__row"><dt>Status</dt><dd>{o?.status || '—'}</dd></div>
            <div className="comms-rail__row"><dt>Total</dt><dd>{money(o?.totalMinor, o?.currency)}</dd></div>
            <div className="comms-rail__row"><dt>Payment</dt><dd>{o?.paymentStatus || '—'}</dd></div>
            <div className="comms-rail__row"><dt>Fulfilment</dt><dd>{order?.fulfillments?.length ? `${order.fulfillments.length} fulfilment(s)` : '—'}</dd></div>
            <div className="comms-rail__row"><dt>Shipment</dt><dd>{order?.shipments?.length ? order.shipments[0].status : '—'}</dd></div>
          </dl>
          <Link to={`/orders/${t.orderId}`} className="linkish comms-rail__link">Open order ↗</Link>
        </div>
      )}

      {t.returnRequestId && (
        <div className="comms-rail__card">
          <h3 className="comms-rail__title">Related return</h3>
          <Link to={`/returns/${t.returnRequestId}`} className="linkish comms-rail__link">Open return request ↗</Link>
        </div>
      )}

      {t.warehouseStaff?.length > 0 && (
        <div className="comms-rail__card">
          <h3 className="comms-rail__title">Warehouse team</h3>
          <div className="comms-rail__staff">
            {t.warehouseStaff.map((s) => (
              <div key={s.id} className="comms-rail__staffrow">
                <span>{s.name} · {s.role}</span>
              </div>
            ))}
          </div>
          <p className="comms-composer__hint" style={{ marginTop: 6 }}>Add an internal note and tick “notify the warehouse team” to reach them.</p>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Internal conversation thread
// ---------------------------------------------------------------------------
function InternalThread({ conversationId, meId, onChanged, onBack }) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const [text, setText] = useState('');
  const [mentions, setMentions] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const scrollRef = useRef(null);

  // The component is keyed by conversationId by the parent, so it always
  // mounts fresh — no synchronous reset needed here.
  const load = useCallback(() => {
    adminApi.internal.get(conversationId).then(
      (d) => setState({ status: 'ready', data: d, error: null }),
      (e) => setState({ status: 'error', data: null, error: normalizeApiError(e) }),
    );
  }, [conversationId]);
  useEffect(() => { load(); }, [load]);

  const c = state.data;
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [c?.messages?.length]);
  // Mark read when the thread is open / grows.
  useEffect(() => {
    if (!c?.messages?.length) return;
    const last = c.messages[c.messages.length - 1].id;
    adminApi.internal.markRead(conversationId, last).then(() => onChanged?.(), () => {});
  }, [c?.messages, conversationId, onChanged]);

  const send = async () => {
    setErr(''); setBusy(true);
    try {
      await adminApi.internal.sendMessage(conversationId, text.trim(), mentions);
      setText(''); setMentions([]);
      load(); onChanged?.();
    } catch (e) { setErr(normalizeApiError(e).message); }
    finally { setBusy(false); }
  };

  if (state.status === 'loading') return <div className="comms-col comms-thread"><LoadingState label="Loading conversation…" /></div>;
  if (state.status === 'error') return <div className="comms-col comms-thread"><ErrorState message={state.error?.message} onRetry={load} /></div>;

  const others = (c.participants || []).filter((p) => p.staffId !== meId);

  return (
    <div className="comms-col comms-thread">
      <div className="comms-thread__header">
        <div className="comms-thread__title-row">
          {onBack && <button type="button" className="comms-composer__mode" onClick={onBack}>← Back</button>}
          <h2 className="comms-thread__title">{c.title}</h2>
          <div className="comms-thread__badges">
            <span className="comms-badge comms-badge--internal">{c.kind === 'GROUP' ? 'Group' : 'Direct'} · internal</span>
            {c.orderId && <span className="comms-badge comms-badge--order">Order-linked</span>}
          </div>
        </div>
        <p className="comms-head__sub" style={{ margin: 0 }}>
          {(c.participants || []).map((p) => p.name).join(', ')}
        </p>
        {c.orderId && (
          <dl className="comms-ordercard">
            <div><dt>Linked order</dt><dd>reference</dd></div>
            <Link to={`/orders/${c.orderId}`} className="linkish">View order ↗</Link>
          </dl>
        )}
      </div>

      <div className="comms-messages" ref={scrollRef}>
        {c.messages.map((m) => (
          <div key={m.id} className={`comms-msg ${m.fromMe ? 'comms-msg--out' : 'comms-msg--in'}`}>
            <div className="comms-msg__meta"><span>{m.fromMe ? 'You' : m.senderName}</span><span>· {formatRelative(m.at)}</span></div>
            <div className="comms-msg__bubble">
              {m.body}
              {m.mentions?.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  {m.mentions.map((x) => <span key={x.staffId} className="comms-msg__mention">@{x.name} </span>)}
                </div>
              )}
            </div>
          </div>
        ))}
        {c.messages.length === 0 && <p className="comms-thread__empty">No messages yet — say hello.</p>}
      </div>

      <div className="comms-composer">
        {others.length > 1 && (
          <div className="comms-mentionbar">
            <span className="comms-composer__hint" style={{ alignSelf: 'center' }}>Mention:</span>
            {others.map((p) => (
              <button
                key={p.staffId}
                type="button"
                className={`comms-mentionchip${mentions.includes(p.staffId) ? ' comms-mentionchip--on' : ''}`}
                onClick={() => setMentions((s) => (s.includes(p.staffId) ? s.filter((x) => x !== p.staffId) : [...s, p.staffId]))}
              >
                @{p.name}
              </button>
            ))}
          </div>
        )}
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Message your colleagues…" />
        {err && <InlineAlert tone="error">{err}</InlineAlert>}
        <div className="comms-composer__row">
          <span className="comms-composer__hint">Internal only — never sent to any customer.</span>
          <Button busy={busy} disabled={!text.trim()} onClick={send}>Send</Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// New conversation dialog
// ---------------------------------------------------------------------------
function NewConversationDialog({ open, onClose, onCreated }) {
  const [dir, setDir] = useState([]);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState([]);
  const [subject, setSubject] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    adminApi.internal.directory().then((d) => setDir(d.staff || []), () => setDir([]));
  }, []);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return dir.filter((x) => !s || x.name.toLowerCase().includes(s) || x.email.toLowerCase().includes(s) || x.role.toLowerCase().includes(s));
  }, [dir, q]);

  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const create = async () => {
    setErr(''); setBusy(true);
    try {
      const conv = picked.length === 1
        ? await adminApi.internal.openDirect({ otherStaffId: picked[0] })
        : await adminApi.internal.createGroup({ participantIds: picked, subject: subject.trim() || undefined });
      onCreated(conv.id);
    } catch (e) { setErr(normalizeApiError(e).message); }
    finally { setBusy(false); }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New internal conversation"
      actions={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button busy={busy} disabled={picked.length === 0} onClick={create}>
          {picked.length > 1 ? `Start group (${picked.length})` : 'Start conversation'}
        </Button>
      </>}
    >
      <div className="comms-picker">
        <input className="comms-picker__search" placeholder="Search staff by name, role or email" value={q} onChange={(e) => setQ(e.target.value)} />
        {picked.length > 1 && (
          <input className="comms-picker__search" placeholder="Group name (optional)" value={subject} onChange={(e) => setSubject(e.target.value)} />
        )}
        {err && <InlineAlert tone="error">{err}</InlineAlert>}
        <div className="comms-picker__list">
          {filtered.map((s) => (
            <button key={s.id} type="button" className={`comms-picker__item${picked.includes(s.id) ? ' comms-picker__item--on' : ''}`} onClick={() => toggle(s.id)}>
              <span className="comms-avatar comms-avatar--staff">{initials(s.name)}</span>
              <span>
                <span className="comms-picker__name">{s.name}</span>
                <span className="comms-picker__sub"> {s.role}{s.warehouses?.length ? ` · ${s.warehouses.map((w) => w.name).join(', ')}` : ''} · {s.email}</span>
              </span>
            </button>
          ))}
          {filtered.length === 0 && <p className="comms-thread__empty">No staff match.</p>}
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export function CommunicationsPage() {
  const { hasPermission, staff } = useAuth();
  const canQueries = hasPermission('support.read');
  const canManage = hasPermission('support.manage');
  const meId = staff?.id;

  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState(() => {
    if (params.get('ic')) return 'internal';
    if (params.get('c')) return 'customer';
    return canQueries ? 'all' : 'internal';
  });
  const [selected, setSelected] = useState(() => {
    if (params.get('ic')) return { kind: 'internal', id: params.get('ic') };
    if (params.get('c')) return { kind: 'ticket', id: params.get('c') };
    return null;
  });
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);
  const narrow = useMediaQuery('(max-width: 820px)');

  const [tickets, setTickets] = useState({ status: 'loading', rows: [], total: 0, error: null });
  const [facets, setFacets] = useState(null);
  const [internal, setInternal] = useState({ status: 'loading', rows: [], error: null });
  const [internalUnread, setInternalUnread] = useState(0);
  const [mentions, setMentions] = useState({ status: 'loading', rows: [] });
  const [staffList, setStaffList] = useState([]);

  const [q, setQ] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [fCategory, setFCategory] = useState('');
  const [fAssigned, setFAssigned] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [newMenu, setNewMenu] = useState(false);

  // staff directory for assignment selects
  useEffect(() => {
    if (!canManage) return;
    adminApi.internal.directory().then((d) => setStaffList(d.staff || []), () => {});
  }, [canManage]);

  // customer queries + facets
  useEffect(() => {
    if (!canQueries) return undefined;
    let live = true;
    const archived = tab === 'archived';
    const query = {
      q: q.trim() || undefined,
      status: fStatus || (archived ? 'CLOSED' : undefined),
      category: fCategory || undefined,
      unassigned: fAssigned === 'unassigned' || undefined,
      mine: fAssigned === 'mine' || undefined,
      limit: 60,
    };
    Promise.all([adminApi.support.list(query), adminApi.support.facets()]).then(
      ([list, f]) => { if (!live) return; setTickets({ status: 'ready', rows: list.tickets || [], total: list.total || 0, error: null }); setFacets(f); },
      (e) => { if (live) setTickets({ status: 'error', rows: [], total: 0, error: normalizeApiError(e) }); },
    );
    return () => { live = false; };
  }, [canQueries, tab, q, fStatus, fCategory, fAssigned, refreshKey]);

  // internal conversations
  useEffect(() => {
    let live = true;
    adminApi.internal.list().then(
      (d) => { if (live) setInternal({ status: 'ready', rows: d.conversations || [], error: null }); },
      (e) => { if (live) setInternal({ status: 'error', rows: [], error: normalizeApiError(e) }); },
    );
    adminApi.internal.unreadCount().then((d) => { if (live) setInternalUnread(d.count || 0); }, () => {});
    return () => { live = false; };
  }, [refreshKey]);

  // mentions feed
  useEffect(() => {
    if (tab !== 'mentions') return undefined;
    let live = true;
    adminApi.notifications.feed({ mine: true, limit: 40 }).then(
      (d) => { if (live) setMentions({ status: 'ready', rows: d.items || [] }); },
      () => { if (live) setMentions({ status: 'ready', rows: [] }); },
    );
    return () => { live = false; };
  }, [tab, refreshKey]);

  // light poll
  useEffect(() => {
    const id = setInterval(bump, 30000);
    return () => clearInterval(id);
  }, [bump]);

  // keep the URL in sync with the selection (deep-linkable from notifications)
  useEffect(() => {
    const next = new URLSearchParams(params);
    next.delete('c'); next.delete('ic');
    if (selected?.kind === 'ticket') next.set('c', selected.id);
    if (selected?.kind === 'internal') next.set('ic', selected.id);
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const selectTicket = (id) => { setSelected({ kind: 'ticket', id }); };
  const selectInternal = (id) => { setSelected({ kind: 'internal', id }); };

  const ticketRows = useMemo(() => {
    if (tab === 'archived') return tickets.rows;
    if (tab === 'internal' || tab === 'mentions') return [];
    return tickets.rows.filter((t) => t.status !== 'CLOSED');
  }, [tickets.rows, tab]);

  const showTicketList = canQueries && (tab === 'all' || tab === 'customer' || tab === 'archived');
  const showInternalList = tab === 'all' || tab === 'internal';

  return (
    <div className="comms">
      <div className="comms-head">
        <div>
          <h1 className="comms-head__title">Communications</h1>
          <p className="comms-head__sub">Manage customer queries, order issues and internal team conversations in one place.</p>
        </div>
        <div className="comms-head__actions">
          <Link to="/marketing/campaigns?tab=email" className="linkish">Message templates ↗</Link>
          <div className="comms-new">
            <Button onClick={() => setNewMenu((v) => !v)}>New message ▾</Button>
            {newMenu && (
              <div className="comms-new__menu" onMouseLeave={() => setNewMenu(false)}>
                <button type="button" className="comms-new__item" onClick={() => { setNewMenu(false); setShowNew(true); }}>
                  New internal conversation
                  <small>Message a colleague or start a group</small>
                </button>
                <button type="button" className="comms-new__item" disabled title="Customers start conversations from Need Help on the storefront" style={{ opacity: 0.5, cursor: 'default' }}>
                  Customer email
                  <small>Inbound email is not connected yet</small>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="comms-tabs">
        {canQueries && <button type="button" className={`comms-tab${tab === 'all' ? ' comms-tab--active' : ''}`} onClick={() => setTab('all')}>All conversations</button>}
        {canQueries && (
          <button type="button" className={`comms-tab${tab === 'customer' ? ' comms-tab--active' : ''}`} onClick={() => setTab('customer')}>
            Customer queries
            {facets && <span className="comms-tab__count">{facets.open}</span>}
          </button>
        )}
        <button type="button" className={`comms-tab${tab === 'internal' ? ' comms-tab--active' : ''}`} onClick={() => setTab('internal')}>
          Internal chat
          {internalUnread > 0 && <span className="comms-tab__count">{internalUnread}</span>}
        </button>
        <button type="button" className={`comms-tab${tab === 'mentions' ? ' comms-tab--active' : ''}`} onClick={() => setTab('mentions')}>Mentions</button>
        {canQueries && (
          <button type="button" className={`comms-tab${tab === 'archived' ? ' comms-tab--active' : ''}`} onClick={() => setTab('archived')}>
            Archived
            {facets && <span className="comms-tab__count">{facets.closed}</span>}
          </button>
        )}
      </div>

      {tab === 'mentions' ? (
        <div className="comms-col" style={{ maxHeight: 'none' }}>
          {mentions.status === 'loading' && <LoadingState label="Loading mentions…" />}
          {mentions.status === 'ready' && mentions.rows.length === 0 && <p className="comms-inbox__empty">Nothing addressed to you yet. @mentions, direct messages and tickets assigned to you show here.</p>}
          {mentions.rows.map((n) => (
            <button
              key={n.id}
              type="button"
              className="comms-row"
              onClick={() => {
                const m = /[?&](c|ic)=([^&]+)/.exec(n.link || '');
                if (m) { setSelected({ kind: m[1] === 'ic' ? 'internal' : 'ticket', id: m[2] }); setTab(m[1] === 'ic' ? 'internal' : 'customer'); }
              }}
            >
              <span className={`comms-avatar${n.category === 'MENTION' || n.category === 'MESSAGE' ? ' comms-avatar--staff' : ''}`}>{n.category === 'SUPPORT' ? 'S' : '@'}</span>
              <span className="comms-row__main">
                <span className="comms-row__top"><span className="comms-row__name">{n.title}</span></span>
                {n.body && <p className="comms-row__preview">{n.body}</p>}
              </span>
              <span className="comms-row__side">
                <span className="comms-row__time">{formatRelative(n.createdAt)}</span>
                {!n.read && <span className="comms-dot" />}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="comms-workspace">
          {/* LEFT — inbox */}
          <div className={`comms-col comms-inbox-col${narrow && selected ? ' comms-inbox-col--hidden' : ''}`}>
            <div className="comms-inbox__toolbar">
              {showTicketList && (
                <>
                  <input className="comms-inbox__search" placeholder="Search customer, order #, subject…" value={q} onChange={(e) => setQ(e.target.value)} />
                  <div className="comms-inbox__filters">
                    <select value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
                      <option value="">All statuses</option>
                      {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                    <select value={fCategory} onChange={(e) => setFCategory(e.target.value)}>
                      <option value="">All types</option>
                      {CATEGORY_OPTIONS.map((c) => <option key={c} value={c}>{TYPE_LABEL[c]}</option>)}
                    </select>
                    <select value={fAssigned} onChange={(e) => setFAssigned(e.target.value)}>
                      <option value="">Anyone</option>
                      <option value="mine">Assigned to me</option>
                      <option value="unassigned">Unassigned</option>
                    </select>
                  </div>
                </>
              )}
              {!showTicketList && showInternalList && <span className="comms-composer__hint">Your internal conversations</span>}
            </div>

            <div className="comms-inbox__list">
              {showTicketList && tickets.status === 'loading' && <LoadingState label="Loading…" />}
              {showTicketList && tickets.status === 'error' && <ErrorState message={tickets.error?.message} onRetry={bump} />}
              {showTicketList && ticketRows.map((t) => (
                <TicketRow key={t.id} t={t} active={selected?.kind === 'ticket' && selected.id === t.id} onSelect={() => selectTicket(t.id)} />
              ))}
              {showTicketList && tickets.status === 'ready' && ticketRows.length === 0 && !showInternalList && (
                <p className="comms-inbox__empty">No customer conversations{tab === 'archived' ? ' archived' : ''}.</p>
              )}

              {showInternalList && internal.rows.map((c) => (
                <InternalRow key={c.id} c={c} active={selected?.kind === 'internal' && selected.id === c.id} onSelect={() => selectInternal(c.id)} />
              ))}
              {showInternalList && !showTicketList && internal.status === 'ready' && internal.rows.length === 0 && (
                <p className="comms-inbox__empty">No internal conversations yet. Use “New message → New internal conversation”.</p>
              )}
            </div>
          </div>

          {/* CENTER — thread */}
          {!selected && !narrow && (
            <div className="comms-col comms-thread">
              <p className="comms-thread__empty">
                Select a conversation to view it.<br />
                Customer support messages and internal team conversations appear here.
              </p>
            </div>
          )}
          {selected?.kind === 'ticket' && (
            <ThreadWithRail
              key={selected.id}
              ticketId={selected.id}
              staffList={staffList}
              canManage={canManage}
              onChanged={bump}
              onBack={narrow ? () => setSelected(null) : null}
            />
          )}
          {selected?.kind === 'internal' && (
            <>
              <InternalThread key={selected.id} conversationId={selected.id} meId={meId} onChanged={bump} onBack={narrow ? () => setSelected(null) : null} />
              <div className="comms-col comms-rail comms-rail-col">
                <div className="comms-rail__card">
                  <h3 className="comms-rail__title">Conversation</h3>
                  <p className="comms-composer__hint">Internal staff conversation. Nothing here is visible to any customer.</p>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {showNew && (
        <NewConversationDialog
          open
          onClose={() => setShowNew(false)}
          onCreated={(id) => { setShowNew(false); setSelected({ kind: 'internal', id }); setTab('internal'); bump(); }}
        />
      )}
    </div>
  );
}

// Thread + its rail, sharing one fetch of the ticket + order.
function ThreadWithRail({ ticketId, staffList, canManage, onChanged, onBack }) {
  const [ticket, setTicket] = useState(null);
  const [order, setOrder] = useState(null);
  const [error, setError] = useState(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    adminApi.support.get(ticketId).then(
      (d) => { if (live) { setTicket(d); setError(null); } },
      (e) => { if (live) setError(normalizeApiError(e)); },
    );
    return () => { live = false; };
  }, [ticketId, nonce]);

  useEffect(() => {
    if (!ticket?.orderId) return undefined;
    let live = true;
    adminApi.orders.get(ticket.orderId).then((o) => { if (live) setOrder(o); }, () => {});
    return () => { live = false; setOrder(null); };
  }, [ticket?.orderId]);

  const onAct = useCallback(async (fn) => {
    await fn();
    reload();
    onChanged?.();
  }, [reload, onChanged]);

  if (error) return <div className="comms-col comms-thread"><ErrorState message={error.message} onRetry={reload} /></div>;
  if (!ticket) return <div className="comms-col comms-thread"><LoadingState label="Loading conversation…" /></div>;

  return (
    <>
      <TicketThreadBody ticket={ticket} order={order} canManage={canManage} onReplied={() => { reload(); onChanged?.(); }} onBack={onBack} />
      <div className="comms-col comms-rail comms-rail-col">
        <TicketRail t={ticket} order={order} staffList={staffList} canManage={canManage} onAct={onAct} />
      </div>
    </>
  );
}

function TicketThreadBody({ ticket: t, order, canManage, onReplied, onBack }) {
  const [mode, setMode] = useState('CUSTOMER');
  const [text, setText] = useState('');
  const [notifyWh, setNotifyWh] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const scrollRef = useRef(null);
  const o = order?.order;

  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [t.messages.length]);

  const send = async () => {
    setErr(''); setBusy(true);
    try {
      await adminApi.support.reply(t.id, text.trim(), mode, mode === 'INTERNAL' && notifyWh);
      setText(''); setNotifyWh(false);
      onReplied();
    } catch (e) { setErr(normalizeApiError(e).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="comms-col comms-thread">
      <div className="comms-thread__header">
        <div className="comms-thread__title-row">
          {onBack && <button type="button" className="comms-composer__mode" onClick={onBack}>← Back</button>}
          <h2 className="comms-thread__title">{t.subject}</h2>
          <div className="comms-thread__badges">
            <span className="comms-badge">{TYPE_LABEL[t.category] || t.category}</span>
            <span className="comms-badge">{STATUS_LABEL[t.status] || t.status}</span>
          </div>
        </div>
        <p className="comms-head__sub" style={{ margin: 0 }}>
          {t.ticketNumber} · {t.customer?.name || 'Customer'}{t.customer?.emailMasked ? ` · ${t.customer.emailMasked}` : ''}
        </p>
        {t.orderId && (
          <dl className="comms-ordercard">
            <div><dt>Order</dt><dd>{o?.orderNumber || t.context?.orderNumber || '—'}</dd></div>
            <div><dt>Placed</dt><dd>{o?.placedAt ? formatRelative(o.placedAt) : '—'}</dd></div>
            <div><dt>Amount</dt><dd>{money(o?.totalMinor, o?.currency)}</dd></div>
            <div><dt>Payment</dt><dd>{o?.paymentMode || o?.paymentStatus || '—'}</dd></div>
            <Link to={`/orders/${t.orderId}`} className="linkish">View order ↗</Link>
          </dl>
        )}
      </div>

      <div className="comms-messages" ref={scrollRef}>
        {t.messages.map((m, i) => {
          const system = m.authorType === 'SYSTEM';
          const internal = m.visibility === 'INTERNAL';
          const out = m.authorType === 'STAFF';
          return (
            <div key={i} className={`comms-msg ${system ? 'comms-msg--system' : out ? 'comms-msg--out' : 'comms-msg--in'}${internal ? ' comms-msg--internal' : ''}`}>
              {!system && (
                <div className="comms-msg__meta">
                  <span>{out ? (internal ? 'Internal note' : 'Support') : (t.customer?.name || 'Customer')}</span>
                  <span>· {formatRelative(m.at)}</span>
                  {internal && <span>· hidden from customer</span>}
                </div>
              )}
              <div className="comms-msg__bubble">{m.body}</div>
              {(m.attachments || []).length > 0 && (
                <ul className="comms-msg__files">
                  {m.attachments.map((f) => (
                    <li key={f.id}>
                      {/* Served by a permission-checked admin route, scoped to
                          this ticket — there is no public URL for a file a
                          customer sent us. */}
                      <a
                        href={`${import.meta.env.VITE_API_BASE_URL}/api/v1/admin/support/tickets/${t.id}/attachments/${f.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {f.fileName}
                      </a>
                      <span className="comms-msg__files-size">{Math.max(1, Math.round(f.byteSize / 1024))} KB</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
        {t.messages.length === 0 && <p className="comms-thread__empty">No messages.</p>}
      </div>

      {canManage && t.status !== 'CLOSED' ? (
        <div className="comms-composer">
          <div className="comms-composer__modes">
            <button type="button" className={`comms-composer__mode${mode === 'CUSTOMER' ? ' comms-composer__mode--active' : ''}`} onClick={() => setMode('CUSTOMER')}>Reply to customer</button>
            <button type="button" className={`comms-composer__mode comms-composer__mode--internal${mode === 'INTERNAL' ? ' comms-composer__mode--active' : ''}`} onClick={() => setMode('INTERNAL')}>Internal note</button>
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={mode === 'CUSTOMER' ? 'Reply — emailed to the customer from support@corcotton.in' : 'Internal note — staff only'}
          />
          {err && <InlineAlert tone="error">{err}</InlineAlert>}
          <div className="comms-composer__row">
            <span className="comms-composer__hint">
              {mode === 'CUSTOMER' ? 'From support@corcotton.in — replies return to this conversation.' : 'Internal only — never sent to the customer.'}
            </span>
            {mode === 'INTERNAL' && t.warehouseId && (
              <label className="comms-composer__check">
                <input type="checkbox" checked={notifyWh} onChange={(e) => setNotifyWh(e.target.checked)} />
                Notify the warehouse team
              </label>
            )}
            <Button variant={mode === 'CUSTOMER' ? 'primary' : 'soft'} busy={busy} disabled={!text.trim()} onClick={send}>{mode === 'CUSTOMER' ? 'Send reply' : 'Add note'}</Button>
          </div>
        </div>
      ) : (
        <div className="comms-composer"><span className="comms-composer__hint">{t.status === 'CLOSED' ? 'This conversation is closed.' : 'You do not have permission to reply.'}</span></div>
      )}
    </div>
  );
}

export default CommunicationsPage;
