import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminApi } from '../api/adminApi.js';
import { useAuth } from '../auth/useAuth.js';
import { formatMoneyFull } from '../features/dashboard/dashboardFormat.js';
import './GlobalSearch.css';

// Real global search. Fans out to the existing admin list endpoints that
// already accept a text query — no new backend. Each entity group is only
// queried when the staff session holds the permission that route requires,
// and every result deep-links to an existing CMS route. Nothing here is
// decorative: an empty query shows nothing, a failed group is silently
// skipped.
const GROUPS = [
  {
    key: 'products',
    label: 'Products',
    perm: 'catalog.read',
    run: (q) => adminApi.catalog.listProducts({ q, limit: 5 }),
    map: (d) => (d?.products || []).map((p) => ({
      id: p.id, to: `/products/${p.id}`, title: p.name, sub: p.slug,
    })),
  },
  {
    key: 'orders',
    label: 'Orders',
    perm: 'orders.read',
    run: (q) => adminApi.orders.list({ q, limit: 5 }),
    map: (d) => (d?.orders || []).map((o) => ({
      id: o.id, to: `/orders/${o.id}`, title: o.order_number,
      sub: [o.customer_name, o.total_minor != null ? formatMoneyFull(o.total_minor) : null].filter(Boolean).join(' · '),
    })),
  },
  {
    key: 'customers',
    label: 'Customers',
    perm: 'customers.read',
    run: (q) => adminApi.customers.list({ search: q, limit: 5 }),
    map: (d) => (d?.customers || []).map((c) => ({
      id: c.id, to: `/customers/${c.id}`, title: c.name || c.email || 'Customer', sub: c.email || c.phone || '',
    })),
  },
];

export function GlobalSearch() {
  const navigate = useNavigate();
  const { permissions } = useAuth();
  const permKey = permissions.join(',');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const groups = useMemo(() => GROUPS.filter((g) => permissions.includes(g.perm)), [permKey]);

  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const [sections, setSections] = useState([]); // [{ label, items: [{id,to,title,sub}] }]
  const [fetchedFor, setFetchedFor] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef(null);
  const inputRef = useRef(null);

  const freshSections = useMemo(
    () => (term.trim() === fetchedFor ? sections : []),
    [sections, term, fetchedFor],
  );
  const flat = useMemo(() => freshSections.flatMap((s) => s.items), [freshSections]);

  // Debounced fan-out. All state writes happen inside the timeout callback
  // (never synchronously in the effect body).
  useEffect(() => {
    const q = term.trim();
    if (q.length < 2) return undefined;
    let cancelled = false;
    const t = setTimeout(async () => {
      const settled = await Promise.all(groups.map(async (g) => {
        try {
          const items = g.map(await g.run(q));
          return items.length ? { label: g.label, items } : null;
        } catch {
          return null; // 403 / transient — skip this group, never surface a fake row
        }
      }));
      if (cancelled) return;
      setSections(settled.filter(Boolean));
      setActive(0);
      setFetchedFor(q);
    }, 280);
    return () => { cancelled = true; clearTimeout(t); };
  }, [term, groups]);

  const q = term.trim();
  const loading = q.length >= 2 && q !== fetchedFor;

  // Close on outside click.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Cmd/Ctrl+K focuses the field.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const go = useCallback((item) => {
    if (!item) return;
    setOpen(false);
    setTerm('');
    setSections([]);
    navigate(item.to);
  }, [navigate]);

  const onKeyDown = (e) => {
    if (!open) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, flat.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); go(flat[active]); }
    else if (e.key === 'Escape') { setOpen(false); }
  };

  if (groups.length === 0) return <div className="global-search global-search--placeholder" aria-hidden="true" />;

  const showPanel = open && q.length >= 2;

  return (
    <div className="global-search" ref={rootRef}>
      <div className="global-search__field">
        <svg className="global-search__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
        </svg>
        <input
          ref={inputRef}
          type="search"
          className="global-search__input"
          placeholder="Search products, orders, customers..."
          value={term}
          onChange={(e) => { setTerm(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={showPanel}
          aria-controls="global-search-results"
        />
        <kbd className="global-search__kbd" aria-hidden="true">⌘K</kbd>
      </div>

      {showPanel && (
        <div className="global-search__panel" id="global-search-results" role="listbox">
          {loading && <p className="global-search__empty">Searching…</p>}
          {!loading && flat.length === 0 && <p className="global-search__empty">No matches for “{q}”.</p>}
          {!loading && freshSections.map((section) => (
            <div key={section.label} className="global-search__group">
              <p className="global-search__group-label">{section.label}</p>
              {section.items.map((item) => {
                const idx = flat.indexOf(item);
                return (
                  <button
                    type="button"
                    key={item.id}
                    className={`global-search__result${idx === active ? ' is-active' : ''}`}
                    role="option"
                    aria-selected={idx === active}
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => go(item)}
                  >
                    <span className="global-search__result-title">{item.title}</span>
                    {item.sub && <span className="global-search__result-sub">{item.sub}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default GlobalSearch;
