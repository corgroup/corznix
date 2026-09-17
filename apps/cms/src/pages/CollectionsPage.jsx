import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageShell } from '../layout/PageShell.jsx';
import { Button } from '../components/ui/Button.jsx';
import { FormField } from '../components/ui/FormField.jsx';
import { Select } from '../components/ui/Select.jsx';
import { Badge } from '../components/ui/Badge.jsx';
import { RowMenu } from '../components/ui/RowMenu.jsx';
import { InlineAlert } from '../components/feedback/InlineAlert.jsx';
import { LoadingState } from '../components/feedback/LoadingState.jsx';
import { ErrorState } from '../components/feedback/ErrorState.jsx';
import { adminApi } from '../api/adminApi.js';
import { EntityUsage, EntityDeleteDialog } from '../components/content/EntityUsage.jsx';
import { useApiResource } from '../hooks/useApiResource.js';
import { useMutation } from '../features/catalog/useMutation.js';
import { useAuth } from '../auth/useAuth.js';
import { formatRelative } from '../utils/format.js';
import './CollectionsPage.css';

const STATUS_OPTIONS = [['ACTIVE', 'Active'], ['ARCHIVED', 'Archived']];
const VIS_OPTIONS = [['visible', 'Storefront visible'], ['hidden', 'Hidden']];
const SORT_OPTIONS = [
  ['order', 'Sort order (asc)'],
  ['order_desc', 'Sort order (desc)'],
  ['name', 'Name A–Z'],
  ['products', 'Most products'],
  ['updated', 'Recently updated'],
];

function Thumbs({ urls }) {
  if (!urls?.length) {
    return <span className="col-thumbs col-thumbs--empty" aria-hidden="true">◫</span>;
  }
  return (
    <span className="col-thumbs">
      {urls.slice(0, 3).map((u, i) => <img key={i} src={u} alt="" loading="lazy" />)}
    </span>
  );
}

function StatCard({ label, value, sub, tone, active, onClick }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} className={`stat-card${tone ? ` stat-card--${tone}` : ''}`}
      aria-pressed={onClick ? active || undefined : undefined} onClick={onClick}>
      <p className="stat-card__label">{label}</p>
      <p className="stat-card__value">{value ?? '—'}</p>
      {sub && <p className="stat-card__sub">{sub}</p>}
    </Tag>
  );
}

function OrderCell({ collection, canWrite, onSaved }) {
  const [value, setValue] = useState(String(collection.displayOrder ?? 0));
  const [save, { busy }] = useMutation((n) => adminApi.catalog.updateCollection(collection.id, { displayOrder: n }));
  const dirty = String(collection.displayOrder ?? 0) !== value.trim();
  const commit = async () => {
    const n = Number(value);
    if (!dirty || Number.isNaN(n) || n < 0) { setValue(String(collection.displayOrder ?? 0)); return; }
    try { await save(n); onSaved(); } catch { setValue(String(collection.displayOrder ?? 0)); }
  };
  if (!canWrite) return <span>{collection.displayOrder}</span>;
  return (
    <input className="order-input" type="number" min="0" value={value} disabled={busy}
      onClick={(e) => e.stopPropagation()} onChange={(e) => setValue(e.target.value)}
      onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      aria-label={`Sort order for ${collection.name}`} />
  );
}

export function CollectionsPage() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('catalog.write');
  const { status, data, error, reload } = useApiResource(() => adminApi.catalog.collections());
  const facetsRes = useApiResource(() => adminApi.catalog.collectionFacets());

  const [showNew, setShowNew] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [view, setView] = useState('list');
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState(null);
  const [visFilter, setVisFilter] = useState(null);
  const [sort, setSort] = useState('order');

  const collections = useMemo(() => data?.collections ?? [], [data]);
  const refreshAll = () => { reload(); facetsRes.reload(); };

  const filtered = useMemo(() => {
    let list = [...collections];
    const needle = q.trim().toLowerCase();
    if (needle) list = list.filter((c) => c.name.toLowerCase().includes(needle) || c.slug.toLowerCase().includes(needle));
    if (statusFilter) list = list.filter((c) => c.status === statusFilter);
    if (visFilter === 'visible') list = list.filter((c) => c.status === 'ACTIVE');
    if (visFilter === 'hidden') list = list.filter((c) => c.status !== 'ACTIVE');
    const cmp = {
      order: (a, b) => (a.displayOrder - b.displayOrder) || a.name.localeCompare(b.name),
      order_desc: (a, b) => (b.displayOrder - a.displayOrder) || a.name.localeCompare(b.name),
      name: (a, b) => a.name.localeCompare(b.name),
      products: (a, b) => b.productCount - a.productCount,
      updated: (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
    }[sort];
    return list.sort(cmp);
  }, [collections, q, statusFilter, visFilter, sort]);

  const anyFilter = Boolean(q.trim() || statusFilter || visFilter);
  const f = facetsRes.data;

  const [toggleStatus, { busy: statusBusy }] = useMutation(
    ({ id, next }) => adminApi.catalog.setCollectionStatus(id, next),
  );
  const changeStatus = async (c) => {
    try { await toggleStatus({ id: c.id, next: c.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE' }); refreshAll(); } catch { /* surfaced */ }
  };

  const assignedPct = (c) => (c.productCount === 0 ? 0 : Math.round((c.activeProductCount / c.productCount) * 100));

  return (
    <PageShell
      title="Collections"
      description="Curated product groupings for the storefront. Manage membership, sort order, visibility and merchandising."
      actions={canWrite && <Button onClick={() => { setShowNew((v) => !v); setOpenId(null); }}>{showNew ? 'Close' : 'New collection'}</Button>}
    >
      <div className="col-strip">
        <StatCard label="Total collections" value={f?.total} sub="All curated collections" tone="neutral"
          active={!anyFilter} onClick={() => { setQ(''); setStatusFilter(null); setVisFilter(null); }} />
        <StatCard label="Active" value={f?.active} sub="Currently active" tone="good"
          active={statusFilter === 'ACTIVE'} onClick={() => setStatusFilter(statusFilter === 'ACTIVE' ? null : 'ACTIVE')} />
        <StatCard label="Products assigned" value={f?.productsAssigned} sub="Distinct across collections" tone="neutral" />
        <StatCard label="Manual order" value={f?.manualOrder ? 'Enabled' : '—'} sub="Manual merchandising" tone="neutral" />
      </div>

      {showNew && canWrite && <CollectionForm onDone={() => { setShowNew(false); refreshAll(); }} />}

      <div className="col-toolbar">
        <input className="col-toolbar__search" type="search" placeholder="Search collection name or slug…"
          value={q} onChange={(e) => setQ(e.target.value)} />
        <Select id="col-f-status" label="Status" value={statusFilter} onChange={setStatusFilter}
          options={STATUS_OPTIONS} includeBlank blankLabel="All statuses" />
        <Select id="col-f-vis" label="Visibility" value={visFilter} onChange={setVisFilter}
          options={VIS_OPTIONS} includeBlank blankLabel="All visibility" />
        <Select id="col-f-sort" label="Sort by" value={sort} onChange={(v) => setSort(v || 'order')} options={SORT_OPTIONS} />
        <div className="view-toggle" role="group" aria-label="View mode">
          <button type="button" className={view === 'list' ? 'is-active' : ''} onClick={() => setView('list')}>List</button>
          <button type="button" className={view === 'grid' ? 'is-active' : ''} onClick={() => setView('grid')}>Grid</button>
        </div>
        <a className="btn btn--secondary" href={adminApi.catalog.collectionsExportUrl()}>Export CSV</a>
      </div>

      {status === 'loading' && <LoadingState label="Loading collections…" />}
      {status === 'error' && <ErrorState message={error?.message} onRetry={reload} />}

      {status === 'ready' && view === 'grid' && (
        <div className="col-grid">
          {filtered.map((c) => (
            <button type="button" key={c.id} className="col-card" onClick={() => { setOpenId(c.id); setShowNew(false); }}>
              <Thumbs urls={c.thumbnails} />
              <span className="col-card__name">{c.name}</span>
              {c.description && <span className="col-card__desc">{c.description}</span>}
              <span className="col-card__meta">
                <Badge>{c.status}</Badge>
                <span>{c.activeProductCount}/{c.productCount} products</span>
              </span>
            </button>
          ))}
          {filtered.length === 0 && <p className="data-table__empty">{anyFilter ? 'No collections match.' : 'No collections.'}</p>}
        </div>
      )}

      {status === 'ready' && view === 'list' && (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Collection</th><th>Slug</th><th>Products</th><th>Sort order</th>
                <th>Status</th><th>Updated</th><th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id} className="data-table__row-link" onClick={() => { setOpenId(c.id); setShowNew(false); }}>
                  <td>
                    <div className="col-cell">
                      <Thumbs urls={c.thumbnails} />
                      <div>
                        <span className="col-cell__name">{c.name}</span>
                        {c.description && <span className="col-cell__desc">{c.description}</span>}
                      </div>
                    </div>
                  </td>
                  <td><code>{c.slug}</code></td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div className="col-assigned">
                      <span>{c.activeProductCount}/{c.productCount}</span>
                      <span className="col-assigned__bar"><span style={{ width: `${assignedPct(c)}%` }} /></span>
                    </div>
                  </td>
                  <td onClick={(e) => e.stopPropagation()}><OrderCell collection={c} canWrite={canWrite} onSaved={refreshAll} /></td>
                  <td>
                    <Badge>{c.status}</Badge>
                    <div className="col-vis">{c.status === 'ACTIVE' ? 'Storefront visible' : 'Hidden'}</div>
                  </td>
                  <td className="text-faint">{formatRelative(c.updatedAt)}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <RowMenu label={`Actions for ${c.name}`}>
                      <button type="button" role="menuitem" onClick={() => { setOpenId(c.id); setShowNew(false); }}>Open</button>
                      <Link role="menuitem" to={`/products?collection=${c.id}`}>View products</Link>
                      {canWrite && (
                        <button type="button" role="menuitem" disabled={statusBusy} onClick={() => changeStatus(c)}>
                          {c.status === 'ACTIVE' ? 'Hide (archive)' : 'Make visible'}
                        </button>
                      )}
                    </RowMenu>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={7} className="data-table__empty">{anyFilter ? 'No collections match.' : 'No collections.'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {openId && <CollectionEditor key={openId} id={openId} canWrite={canWrite} onChanged={refreshAll} onClose={() => setOpenId(null)} />}
    </PageShell>
  );
}

function CollectionForm({ collection, onDone }) {
  const editing = Boolean(collection);
  const [form, setForm] = useState({
    name: collection?.name ?? '', slug: collection?.slug ?? '', description: collection?.description ?? '',
    displayOrder: String(collection?.displayOrder ?? 0), status: collection?.status ?? 'ACTIVE',
  });
  const set = (k) => (v) => setForm((s) => ({ ...s, [k]: v }));
  const [save, { busy, error }] = useMutation((body) => (editing
    ? adminApi.catalog.updateCollection(collection.id, body)
    : adminApi.catalog.createCollection(body)));

  return (
    <form
      className="col-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const body = { name: form.name.trim(), description: form.description.trim() || null, displayOrder: Number(form.displayOrder) || 0, status: form.status };
        if (form.slug.trim() && form.slug.trim() !== collection?.slug) body.slug = form.slug.trim();
        try { await save(body); onDone(); } catch { /* surfaced */ }
      }}
    >
      <h2 className="col-form__title">{editing ? `Edit ${collection.name}` : 'New collection'}</h2>
      <div className="col-form__grid">
        <FormField id="col-name" label="Name" value={form.name} onChange={set('name')} required />
        <FormField id="col-slug" label="Slug (leave blank to derive)" value={form.slug} onChange={set('slug')} />
        <FormField id="col-order" label="Display order" type="number" value={form.displayOrder} onChange={set('displayOrder')} />
        <Select id="col-status" label="Status" value={form.status} onChange={set('status')}
          options={[['ACTIVE', 'Active'], ['ARCHIVED', 'Archived']]} />
        <FormField id="col-desc" label="Description" value={form.description} onChange={set('description')} />
      </div>
      {error && <InlineAlert tone="error">{error.message}</InlineAlert>}
      <div className="col-form__actions">
        <Button type="submit" busy={busy} disabled={!form.name.trim()}>{editing ? 'Save' : 'Create'}</Button>
        <Button variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

function CollectionEditor({ id, canWrite, onChanged, onClose }) {
  const { status, data, error, reload } = useApiResource(() => adminApi.catalog.getCollection(id));
  const { data: productData } = useApiResource(() => adminApi.catalog.listProducts({ limit: 100, status: 'ACTIVE' }));
  const [act, { error: actErr }] = useMutation(async (fn) => fn());
  const [del, { error: delErr }] = useMutation((confirmReferences) => adminApi.catalog.deleteCollection(id, { confirmReferences }));
  const [addId, setAddId] = useState(null);
  const [deleting, setDeleting] = useState(false);

  if (status === 'loading') return <LoadingState label="Loading collection…" />;
  if (status === 'error') return <ErrorState message={error?.message} onRetry={reload} />;

  const members = data.members;
  const memberIds = new Set(members.map((m) => m.id));
  const candidates = (productData?.products ?? []).filter((p) => !memberIds.has(p.id));
  // Resolves to whether it worked; the failure itself is shown by actErr below.
  const run = async (fn) => { try { await act(fn); reload(); onChanged(); return true; } catch { return false; } };
  const move = (arr, from, to) => { const n = [...arr]; const [x] = n.splice(from, 1); n.splice(to, 0, x); return n; };

  return (
    <section className="col-editor">
      <div className="col-editor__head">
        <h2 className="col-editor__title">{data.name} — {members.length} product{members.length === 1 ? '' : 's'}</h2>
        <button type="button" className="linkish" onClick={onClose}>Close</button>
      </div>
      <CollectionForm collection={data} onDone={() => { reload(); onChanged(); }} />
      <EntityUsage type="COLLECTION" id={id} />
      {actErr && <InlineAlert tone="error">{actErr.message}</InlineAlert>}

      {canWrite && (
        <div className="col-editor__add">
          <Select id="col-add" label="Add product" value={addId} onChange={setAddId} includeBlank blankLabel="— choose —"
            options={candidates.map((p) => [p.id, p.name])} />
          <Button variant="soft" disabled={!addId} onClick={async () => { if (await run(() => adminApi.catalog.addCollectionMember(id, addId))) setAddId(null); }}>Add</Button>
        </div>
      )}

      <div className="table-wrap">
        <table className="data-table">
          <thead><tr><th>#</th><th>Product</th><th>Status</th><th aria-label="Actions" /></tr></thead>
          <tbody>
            {members.map((m, i) => (
              <tr key={m.id}>
                <td>{m.position}</td>
                <td>
                  <span className="col-cell">
                    {m.imageUrl
                      ? <img className="col-member-thumb" src={m.imageUrl} alt="" loading="lazy" />
                      : <span className="col-member-thumb col-member-thumb--empty" aria-hidden="true">◫</span>}
                    {m.name}
                  </span>
                </td>
                <td><Badge>{m.status}</Badge></td>
                <td>
                  {canWrite && (
                    <span className="col-member__actions">
                      <button type="button" className="linkish" disabled={i === 0}
                        onClick={() => run(() => adminApi.catalog.reorderCollection(id, move(members.map((x) => x.id), i, i - 1)))}>↑</button>
                      <button type="button" className="linkish" disabled={i === members.length - 1}
                        onClick={() => run(() => adminApi.catalog.reorderCollection(id, move(members.map((x) => x.id), i, i + 1)))}>↓</button>
                      <button type="button" className="linkish is-danger"
                        onClick={() => run(() => adminApi.catalog.removeCollectionMember(id, m.id))}>Remove</button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {members.length === 0 && <tr><td colSpan={4} className="data-table__empty">No products in this collection.</td></tr>}
          </tbody>
        </table>
      </div>

      {canWrite && members.length === 0 && (
        <button
          type="button"
          className="linkish is-danger"
          onClick={() => setDeleting(true)}
        >
          Delete collection
        </button>
      )}
      <EntityDeleteDialog
        open={deleting}
        type="COLLECTION"
        id={id}
        name={data.name}
        onCancel={() => setDeleting(false)}
        onConfirm={async (confirmReferences) => {
          try { await del(confirmReferences); setDeleting(false); onChanged(); onClose(); } catch { setDeleting(false); /* surfaced below */ }
        }}
      />
      {delErr && <InlineAlert tone="error">{delErr.message}</InlineAlert>}
    </section>
  );
}

export default CollectionsPage;
