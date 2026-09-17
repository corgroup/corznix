import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { PageShell } from '../layout/PageShell.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Select } from '../components/ui/Select.jsx';
import { Badge } from '../components/ui/Badge.jsx';
import { LoadingState } from '../components/feedback/LoadingState.jsx';
import { ErrorState } from '../components/feedback/ErrorState.jsx';
import { InlineAlert } from '../components/feedback/InlineAlert.jsx';
import { adminApi } from '../api/adminApi.js';
import { useAuth } from '../auth/useAuth.js';
import { normalizeApiError } from '../utils/errors.js';
import { formatPriceRange, titleCase, formatDateTime } from '../utils/format.js';
import { useMutation } from '../features/catalog/useMutation.js';
import { RowMenu } from '../components/ui/RowMenu.jsx';
import './ProductsPage.css';

const STATUS_OPTIONS = [['DRAFT', 'Draft'], ['ACTIVE', 'Active'], ['ARCHIVED', 'Archived']];
const SHIPPING_OPTIONS = [
  ['RATE_READY', 'Rate ready'],
  ['NOT_RATE_READY', 'Not rate ready'],
  ['COMPLETE', 'Metadata complete'],
  ['INCOMPLETE', 'Metadata incomplete'],
];
const SIZE_GUIDE_OPTIONS = [['assigned', 'Assigned'], ['unassigned', 'Not assigned']];
const SORT_OPTIONS = [
  ['updated', 'Recently updated'],
  ['created', 'Newest'],
  ['name', 'Name A–Z'],
  ['name_desc', 'Name Z–A'],
];
const PAGE_SIZES = [10, 20, 50];
const NEXT_STATUS = { DRAFT: 'ACTIVE', ACTIVE: 'ARCHIVED', ARCHIVED: 'ACTIVE' };
const STATUS_ACTION = { DRAFT: 'Publish', ACTIVE: 'Archive', ARCHIVED: 'Restore' };

function SearchBox({ initial, onSubmit }) {
  const [value, setValue] = useState(initial);
  return (
    <form
      className="products-toolbar__search"
      onSubmit={(e) => { e.preventDefault(); onSubmit(value.trim() || null); }}
    >
      <input
        type="search"
        placeholder="Search name, slug or SKU…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <Button type="submit" variant="secondary">Search</Button>
    </form>
  );
}

function StatCard({ label, value, tone, active, onClick }) {
  return (
    <button
      type="button"
      className={`stat-card${tone ? ` stat-card--${tone}` : ''}`}
      aria-pressed={active || undefined}
      onClick={onClick}
    >
      <p className="stat-card__label">{label}</p>
      <p className="stat-card__value">{value ?? '—'}</p>
    </button>
  );
}

const FolderIcon = () => (
  <svg className="cat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
  </svg>
);

function ProductRowMenu({ product, canWrite, onEdit, onToggleStatus, busy }) {
  return (
    <RowMenu label={`Actions for ${product.name}`}>
      <button type="button" role="menuitem" onClick={onEdit}>Edit product</button>
      {canWrite && (
        <button type="button" role="menuitem" disabled={busy} onClick={onToggleStatus}>
          {STATUS_ACTION[product.status]}
        </button>
      )}
      {product.status === 'ACTIVE' && product.slug && (
        <a
          role="menuitem"
          href={`${import.meta.env.VITE_STOREFRONT_URL || ''}/products/${product.slug}`}
          target="_blank"
          rel="noreferrer"
        >
          View on storefront
        </a>
      )}
    </RowMenu>
  );
}

export function ProductsPage() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('catalog.write');
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const query = useMemo(() => ({
    q: searchParams.get('q') || '',
    status: searchParams.get('status') || null,
    category: searchParams.get('category') || null,
    collection: searchParams.get('collection') || null,
    sizeGuide: searchParams.get('sizeGuide') || null,
    shipping: searchParams.get('shipping') || null,
    sort: searchParams.get('sort') || 'updated',
    page: Number(searchParams.get('page') || 1),
    limit: PAGE_SIZES.includes(Number(searchParams.get('limit'))) ? Number(searchParams.get('limit')) : 20,
  }), [searchParams]);

  const anyFilter = Boolean(
    query.q || query.status || query.category || query.collection || query.sizeGuide || query.shipping,
  );

  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const [facets, setFacets] = useState(null);
  const [pickers, setPickers] = useState({ categories: [], collections: [] });
  const [facetNonce, setFacetNonce] = useState(0);
  const [listNonce, setListNonce] = useState(0);
  const [selected, setSelected] = useState(() => new Set());
  const [bulkNote, setBulkNote] = useState(null);

  useEffect(() => {
    Promise.all([
      adminApi.catalog.categories().catch(() => ({ categories: [] })),
      adminApi.catalog.collections().catch(() => ({ collections: [] })),
    ]).then(([c, col]) => setPickers({
      categories: c.categories || [],
      collections: (col.collections || []).filter((x) => x.status !== 'ARCHIVED'),
    }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    adminApi.catalog.productFacets().then(
      (d) => { if (!cancelled) setFacets(d); },
      () => { if (!cancelled) setFacets(null); },
    );
    return () => { cancelled = true; };
  }, [facetNonce]);

  useEffect(() => {
    let cancelled = false;
    adminApi.catalog.listProducts({
      q: query.q || undefined,
      status: query.status || undefined,
      categoryId: query.category || undefined,
      collectionId: query.collection || undefined,
      sizeGuide: query.sizeGuide || undefined,
      shipping: query.shipping || undefined,
      sort: query.sort,
      page: query.page,
      limit: query.limit,
    }).then(
      (data) => { if (!cancelled) { setState({ status: 'ready', data, error: null }); setSelected(new Set()); } },
      (err) => { if (!cancelled) setState({ status: 'error', data: null, error: normalizeApiError(err) }); },
    );
    return () => { cancelled = true; };
  }, [query, listNonce]);

  const patchParams = (patch) => {
    const next = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === undefined || v === '') next.delete(k);
      else next.set(k, String(v));
    }
    if (!('page' in patch)) next.delete('page');
    setSearchParams(next, { replace: true });
  };

  const clearFilters = () => {
    const keep = new URLSearchParams();
    if (query.sort !== 'updated') keep.set('sort', query.sort);
    if (query.limit !== 20) keep.set('limit', String(query.limit));
    setSearchParams(keep, { replace: true });
  };

  const isQuickActive = (patch) => Object.entries(patch).every(([k, v]) => (query[k] || null) === (v || null));
  const applyQuick = (patch) => patchParams(isQuickActive(patch) ? Object.fromEntries(Object.keys(patch).map((k) => [k, null])) : patch);

  const [changeStatus, { busy: statusBusy }] = useMutation(
    ({ id, next }) => adminApi.catalog.setStatus(id, next),
  );
  const [runBulk, { busy: bulkBusy }] = useMutation(
    ({ ids, status }) => adminApi.catalog.bulkStatus(ids, status),
  );
  const [busyRow, setBusyRow] = useState(null);

  const advanceStatus = async (product) => {
    setBusyRow(product.id);
    try {
      await changeStatus({ id: product.id, next: NEXT_STATUS[product.status] });
      setListNonce((n) => n + 1);
      setFacetNonce((n) => n + 1);
    } catch { /* surfaced by mutation */ } finally {
      setBusyRow(null);
    }
  };

  const bulkTo = async (status) => {
    const ids = [...selected];
    if (!ids.length) return;
    try {
      const res = await runBulk({ ids, status });
      setBulkNote({
        tone: res.failed ? 'warning' : 'success',
        text: res.failed
          ? `${res.changed} updated, ${res.failed} could not change (already ${status.toLowerCase()} or locked).`
          : `${res.changed} product${res.changed === 1 ? '' : 's'} set to ${titleCase(status)}.`,
      });
      setListNonce((n) => n + 1);
      setFacetNonce((n) => n + 1);
    } catch (err) {
      setBulkNote({ tone: 'error', text: normalizeApiError(err).message });
    }
  };

  const data = state.data;
  const rows = data?.products || [];
  const allChecked = rows.length > 0 && rows.every((p) => selected.has(p.id));
  const someChecked = selected.size > 0 && !allChecked;

  const toggleAll = () => {
    setSelected(allChecked ? new Set() : new Set(rows.map((p) => p.id)));
  };
  const toggleOne = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const totalPages = data ? Math.max(1, data.totalPages || 1) : 1;
  const pageNumbers = useMemo(() => {
    const out = [];
    const span = 2;
    for (let i = 1; i <= totalPages; i += 1) {
      if (i === 1 || i === totalPages || Math.abs(i - query.page) <= span) out.push(i);
      else if (out[out.length - 1] !== '…') out.push('…');
    }
    return out;
  }, [totalPages, query.page]);

  return (
    <PageShell
      title="Products"
      description="Catalog administration — every product, any status."
      actions={canWrite && <Button onClick={() => navigate('/products/new')}>New product</Button>}
    >
      <div className="products-strip">
        <StatCard label="Total products" value={facets?.total} tone="neutral"
          active={!anyFilter} onClick={clearFilters} />
        <StatCard label="Active" value={facets?.byStatus.ACTIVE} tone="good"
          active={query.status === 'ACTIVE'} onClick={() => patchParams({ status: 'ACTIVE' })} />
        <StatCard label="Draft" value={facets?.byStatus.DRAFT} tone="warn"
          active={query.status === 'DRAFT'} onClick={() => patchParams({ status: 'DRAFT' })} />
        <StatCard label="Needs attention" value={facets?.needsAttention}
          tone={facets?.needsAttention ? 'bad' : 'neutral'}
          active={query.status === 'ACTIVE' && query.shipping === 'NOT_RATE_READY'}
          onClick={() => patchParams({ status: 'ACTIVE', shipping: 'NOT_RATE_READY' })} />
        <StatCard label="Shipping not ready" value={facets?.shipping.notRateReady}
          tone={facets?.shipping.notRateReady ? 'warn' : 'neutral'}
          active={query.shipping === 'NOT_RATE_READY' && query.status !== 'ACTIVE'}
          onClick={() => patchParams({ shipping: 'NOT_RATE_READY', status: null })} />
        <StatCard label="No size guide" value={facets?.sizeGuide.unassigned}
          tone={facets?.sizeGuide.unassigned ? 'warn' : 'neutral'}
          active={query.sizeGuide === 'unassigned'}
          onClick={() => patchParams({ sizeGuide: 'unassigned' })} />
      </div>

      <div className="products-toolbar">
        <SearchBox key={query.q} initial={query.q} onSubmit={(q) => patchParams({ q })} />
        <Select id="f-status" label="Status" value={query.status} onChange={(v) => patchParams({ status: v })}
          options={STATUS_OPTIONS} includeBlank blankLabel="Any status" />
        <Select id="f-category" label="Category" value={query.category} onChange={(v) => patchParams({ category: v })}
          options={pickers.categories.map((c) => [c.id, c.name])} includeBlank blankLabel="Any category" />
        <Select id="f-collection" label="Collection" value={query.collection} onChange={(v) => patchParams({ collection: v })}
          options={pickers.collections.map((c) => [c.id, c.name])} includeBlank blankLabel="Any collection" />
        <Select id="f-size-guide" label="Size guide" value={query.sizeGuide} onChange={(v) => patchParams({ sizeGuide: v })}
          options={SIZE_GUIDE_OPTIONS} includeBlank blankLabel="Any" />
        <Select id="f-shipping" label="Shipping" value={query.shipping} onChange={(v) => patchParams({ shipping: v })}
          options={SHIPPING_OPTIONS} includeBlank blankLabel="Any shipping" />
        <Select id="f-sort" label="Sort" value={query.sort} onChange={(v) => patchParams({ sort: v || 'updated' })}
          options={SORT_OPTIONS} />
      </div>

      <div className="products-quick">
        <span className="products-quick__label">Quick filters</span>
        <button type="button" className={`chip${isQuickActive({ status: 'ACTIVE' }) ? ' chip--active' : ''}`}
          onClick={() => applyQuick({ status: 'ACTIVE' })}>Active</button>
        <button type="button" className={`chip${isQuickActive({ status: 'DRAFT' }) ? ' chip--active' : ''}`}
          onClick={() => applyQuick({ status: 'DRAFT' })}>Draft</button>
        <button type="button" className={`chip${isQuickActive({ shipping: 'NOT_RATE_READY' }) ? ' chip--active' : ''}`}
          onClick={() => applyQuick({ shipping: 'NOT_RATE_READY' })}>Missing shipping</button>
        <button type="button" className={`chip${isQuickActive({ sizeGuide: 'unassigned' }) ? ' chip--active' : ''}`}
          onClick={() => applyQuick({ sizeGuide: 'unassigned' })}>Missing size guide</button>
        <button type="button" className={`chip${query.sort === 'updated' && !anyFilter ? ' chip--active' : ''}`}
          onClick={clearFilters}>Recently updated</button>
        {(anyFilter || query.sort !== 'updated') && (
          <button type="button" className="linkish products-quick__clear" onClick={clearFilters}>Clear all</button>
        )}
      </div>

      {state.error?.message && <InlineAlert tone="error">{state.error.message}</InlineAlert>}
      {bulkNote && (
        <InlineAlert tone={bulkNote.tone === 'success' ? 'info' : bulkNote.tone}>{bulkNote.text}</InlineAlert>
      )}

      {state.status === 'loading' && !data && <LoadingState label="Loading products…" />}
      {state.status === 'error' && <ErrorState message={state.error?.message} onRetry={() => setListNonce((n) => n + 1)} />}

      {data && (
        <>
          <div className="products-count-row">
            <span className="text-faint">
              {data.total} product{data.total === 1 ? '' : 's'}
              {anyFilter ? ' match these filters' : ''}
            </span>
          </div>

          {canWrite && selected.size > 0 && (
            <div className="bulk-bar" role="region" aria-label="Bulk actions">
              <span className="bulk-bar__count">{selected.size} selected</span>
              <div className="bulk-bar__actions">
                <Button variant="success" disabled={bulkBusy} onClick={() => bulkTo('ACTIVE')}>Publish</Button>
                <Button variant="warning" disabled={bulkBusy} onClick={() => bulkTo('ARCHIVED')}>Archive</Button>
                <Button variant="warning" disabled={bulkBusy} onClick={() => bulkTo('DRAFT')}>Move to draft</Button>
                <button type="button" className="linkish" onClick={() => setSelected(new Set())}>Clear</button>
              </div>
            </div>
          )}

          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  {canWrite && (
                    <th className="col-check">
                      <input
                        type="checkbox"
                        aria-label="Select all rows"
                        checked={allChecked}
                        ref={(el) => { if (el) el.indeterminate = someChecked; }}
                        onChange={toggleAll}
                      />
                    </th>
                  )}
                  <th>Product</th><th>Status</th><th>Price</th><th>Variants</th><th>SKUs</th>
                  <th>Category</th><th>Collections</th><th>Shipping</th><th>Size guide</th><th>Updated</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr
                    key={p.id}
                    className={`data-table__row-link${selected.has(p.id) ? ' data-table__row--selected' : ''}`}
                    onClick={() => navigate(`/products/${p.id}`)}
                  >
                    {canWrite && (
                      <td className="col-check" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${p.name}`}
                          checked={selected.has(p.id)}
                          onChange={() => toggleOne(p.id)}
                        />
                      </td>
                    )}
                    <td>
                      <div className="product-cell">
                        {p.primaryMedia
                          ? <img className="product-thumb" src={p.primaryMedia} alt="" loading="lazy" />
                          : <span className="product-thumb product-thumb--empty" aria-hidden="true">◫</span>}
                        <div>
                          <Link to={`/products/${p.id}`} onClick={(e) => e.stopPropagation()}>{p.name}</Link>
                          <div className="data-table__sub">
                            <code>{p.slug}</code>{p.productType ? ` · ${titleCase(p.productType)}` : ''}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td><Badge>{p.status}</Badge></td>
                    <td>{formatPriceRange(p.price)}</td>
                    <td>{p.variantCount}</td>
                    <td>{p.skuCount}</td>
                    <td>
                      {p.category
                        ? <span className="cat-cell"><FolderIcon />{p.category.name}</span>
                        : <span className="text-faint">—</span>}
                    </td>
                    <td>{p.collectionCount || <span className="text-faint">0</span>}</td>
                    <td>
                      <Badge tone={p.shipping.rateReady ? 'good' : 'bad'}>
                        {p.shipping.rateReady ? 'Ready' : 'Needs setup'}
                      </Badge>
                    </td>
                    <td>{p.sizeGuideId ? 'Assigned' : <span className="text-faint">None</span>}</td>
                    <td>{formatDateTime(p.updatedAt)}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <ProductRowMenu
                        product={p}
                        canWrite={canWrite}
                        busy={statusBusy && busyRow === p.id}
                        onEdit={() => navigate(`/products/${p.id}`)}
                        onToggleStatus={() => advanceStatus(p)}
                      />
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={canWrite ? 12 : 11} className="data-table__empty">
                      {anyFilter ? 'No products match these filters.' : 'No products yet.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="pager">
            <label className="pager__size">
              Rows per page
              <select
                value={query.limit}
                onChange={(e) => patchParams({ limit: Number(e.target.value), page: 1 })}
              >
                {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <span className="pager__summary">
              {data.total === 0
                ? '0 of 0'
                : `${(query.page - 1) * query.limit + 1}–${Math.min(query.page * query.limit, data.total)} of ${data.total}`}
            </span>
            <div className="pager__buttons">
              <Button variant="secondary" disabled={query.page <= 1} onClick={() => patchParams({ page: query.page - 1 })}>Previous</Button>
              {pageNumbers.map((n, i) => (
                n === '…'
                  ? <span key={`gap-${i}`} className="pager__gap">…</span>
                  : (
                    <button
                      key={n}
                      type="button"
                      className={`pager__num${n === query.page ? ' pager__num--active' : ''}`}
                      onClick={() => patchParams({ page: n })}
                    >
                      {n}
                    </button>
                  )
              ))}
              <Button variant="secondary" disabled={query.page >= totalPages} onClick={() => patchParams({ page: query.page + 1 })}>Next</Button>
            </div>
          </div>
        </>
      )}
    </PageShell>
  );
}

export default ProductsPage;
