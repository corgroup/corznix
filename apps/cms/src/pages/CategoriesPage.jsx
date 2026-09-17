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
import './CategoriesPage.css';

const STATUS_OPTIONS = [['ACTIVE', 'Active'], ['ARCHIVED', 'Archived']];
const SORT_OPTIONS = [
  ['order', 'Sort order (asc)'],
  ['order_desc', 'Sort order (desc)'],
  ['name', 'Name A–Z'],
  ['name_desc', 'Name Z–A'],
  ['products', 'Most products'],
];

const FolderIcon = () => (
  <svg className="cat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
  </svg>
);

function StatCard({ label, value, sub, tone, active, onClick }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      className={`stat-card${tone ? ` stat-card--${tone}` : ''}`}
      aria-pressed={onClick ? active || undefined : undefined}
      onClick={onClick}
    >
      <p className="stat-card__label">{label}</p>
      <p className="stat-card__value">{value ?? '—'}</p>
      {sub && <p className="stat-card__sub">{sub}</p>}
    </Tag>
  );
}

// Inline sort-order editor — commits via the existing updateCategory endpoint.
function OrderCell({ category, canWrite, onSaved }) {
  const [value, setValue] = useState(String(category.displayOrder ?? 0));
  const [save, { busy }] = useMutation((n) => adminApi.catalog.updateCategory(category.id, { displayOrder: n }));
  const dirty = String(category.displayOrder ?? 0) !== value.trim();

  const commit = async () => {
    const n = Number(value);
    if (!dirty || Number.isNaN(n) || n < 0) { setValue(String(category.displayOrder ?? 0)); return; }
    try { await save(n); onSaved(); } catch { setValue(String(category.displayOrder ?? 0)); }
  };

  if (!canWrite) return <span>{category.displayOrder}</span>;
  return (
    <input
      className="order-input"
      type="number"
      min="0"
      value={value}
      disabled={busy}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      aria-label={`Sort order for ${category.name}`}
    />
  );
}

function TreeNode({ node, byParent, depth, onEdit }) {
  const [open, setOpen] = useState(true);
  const kids = byParent.get(node.id) || [];
  return (
    <li className="cat-tree__node">
      <div className="cat-tree__row" style={{ paddingLeft: `${depth * 16}px` }}>
        {kids.length > 0 ? (
          <button type="button" className="cat-tree__toggle" onClick={() => setOpen((v) => !v)} aria-label={open ? 'Collapse' : 'Expand'}>
            {open ? '▾' : '▸'}
          </button>
        ) : <span className="cat-tree__toggle cat-tree__toggle--leaf" />}
        <FolderIcon />
        <button type="button" className="cat-tree__name" onClick={() => onEdit(node.id)}>{node.name}</button>
        <span className="cat-tree__count">{node.productCount}</span>
      </div>
      {open && kids.length > 0 && (
        <ul className="cat-tree__children">
          {kids.map((k) => <TreeNode key={k.id} node={k} byParent={byParent} depth={depth + 1} onEdit={onEdit} />)}
        </ul>
      )}
    </li>
  );
}

export function CategoriesPage() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('catalog.write');
  const { status, data, error, reload } = useApiResource(() => adminApi.catalog.categories());
  const facetsRes = useApiResource(() => adminApi.catalog.categoryFacets());

  const [showNew, setShowNew] = useState(false);
  const [editId, setEditId] = useState(null);
  const [view, setView] = useState('table');
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState(null);
  const [parentFilter, setParentFilter] = useState(null);
  const [sort, setSort] = useState('order');

  const categories = useMemo(() => data?.categories ?? [], [data]);
  const roots = useMemo(() => categories.filter((c) => !c.parentId), [categories]);
  const byParent = useMemo(() => {
    const m = new Map();
    for (const c of categories) {
      if (!c.parentId) continue;
      if (!m.has(c.parentId)) m.set(c.parentId, []);
      m.get(c.parentId).push(c);
    }
    return m;
  }, [categories]);

  const refreshAll = () => { reload(); facetsRes.reload(); };

  const filtered = useMemo(() => {
    let list = [...categories];
    const needle = q.trim().toLowerCase();
    if (needle) list = list.filter((c) => c.name.toLowerCase().includes(needle) || c.slug.toLowerCase().includes(needle));
    if (statusFilter) list = list.filter((c) => c.status === statusFilter);
    if (parentFilter === '__roots__') list = list.filter((c) => !c.parentId);
    else if (parentFilter) list = list.filter((c) => c.parentId === parentFilter || c.id === parentFilter);
    const cmp = {
      order: (a, b) => (a.displayOrder - b.displayOrder) || a.name.localeCompare(b.name),
      order_desc: (a, b) => (b.displayOrder - a.displayOrder) || a.name.localeCompare(b.name),
      name: (a, b) => a.name.localeCompare(b.name),
      name_desc: (a, b) => b.name.localeCompare(a.name),
      products: (a, b) => b.productCount - a.productCount,
    }[sort];
    // Keep children under parents for the default order view.
    if (sort === 'order' || sort === 'order_desc') {
      const rootsSorted = list.filter((c) => !c.parentId).sort(cmp);
      const out = [];
      for (const r of rootsSorted) {
        out.push(r);
        for (const k of list.filter((c) => c.parentId === r.id).sort(cmp)) out.push(k);
      }
      // orphan children whose parent was filtered out
      for (const c of list) if (c.parentId && !rootsSorted.some((r) => r.id === c.parentId)) out.push(c);
      return out;
    }
    return list.sort(cmp);
  }, [categories, q, statusFilter, parentFilter, sort]);

  const anyFilter = Boolean(q.trim() || statusFilter || parentFilter);
  const f = facetsRes.data;

  const [toggleStatus, { busy: statusBusy }] = useMutation(
    ({ id, next }) => adminApi.catalog.setCategoryStatus(id, next),
  );
  const changeStatus = async (c) => {
    try { await toggleStatus({ id: c.id, next: c.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE' }); refreshAll(); } catch { /* surfaced */ }
  };

  return (
    <PageShell
      title="Categories"
      description="Organize your catalog with a clear hierarchy. Manage categories and how they appear in your storefront."
      actions={canWrite && <Button onClick={() => { setShowNew((v) => !v); setEditId(null); }}>{showNew ? 'Close' : 'New category'}</Button>}
    >
      <div className="cat-strip">
        <StatCard label="Total categories" value={f?.total} sub="All categories" tone="neutral"
          active={!anyFilter} onClick={() => { setQ(''); setStatusFilter(null); setParentFilter(null); }} />
        <StatCard label="Parent categories" value={f?.roots} sub="Top level" tone="neutral"
          active={parentFilter === '__roots__'} onClick={() => setParentFilter(parentFilter === '__roots__' ? null : '__roots__')} />
        <StatCard label="Subcategories" value={f?.children} sub="Child categories" tone="neutral" />
        <StatCard label="Products mapped" value={f?.productsMapped} sub="Distinct products" tone="neutral" />
        <StatCard label="Active categories" value={f?.active}
          sub={f && f.total ? `${Math.round((f.active / f.total) * 100)}% active` : null}
          tone="good" active={statusFilter === 'ACTIVE'}
          onClick={() => setStatusFilter(statusFilter === 'ACTIVE' ? null : 'ACTIVE')} />
      </div>

      {showNew && canWrite && <CategoryForm roots={roots} onDone={() => { setShowNew(false); refreshAll(); }} />}
      {editId && (
        <CategoryForm
          key={editId}
          roots={roots}
          category={categories.find((c) => c.id === editId)}
          onDone={() => { setEditId(null); refreshAll(); }}
        />
      )}

      <div className="cat-toolbar">
        <input
          className="cat-toolbar__search"
          type="search"
          placeholder="Search categories…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Select id="cat-f-status" label="Status" value={statusFilter} onChange={setStatusFilter}
          options={STATUS_OPTIONS} includeBlank blankLabel="All statuses" />
        <Select id="cat-f-parent" label="Parent" value={parentFilter} onChange={setParentFilter}
          options={[['__roots__', 'Top level only'], ...roots.map((r) => [r.id, r.name])]} includeBlank blankLabel="All" />
        <Select id="cat-f-sort" label="Sort by" value={sort} onChange={(v) => setSort(v || 'order')} options={SORT_OPTIONS} />
        <div className="view-toggle" role="group" aria-label="View mode">
          <button type="button" className={view === 'table' ? 'is-active' : ''} onClick={() => setView('table')}>Table</button>
          <button type="button" className={view === 'tree' ? 'is-active' : ''} onClick={() => setView('tree')}>Tree</button>
        </div>
        <a className="btn btn--secondary" href={adminApi.catalog.categoriesExportUrl()}>Export CSV</a>
      </div>

      {status === 'loading' && <LoadingState label="Loading categories…" />}
      {status === 'error' && <ErrorState message={error?.message} onRetry={reload} />}

      {status === 'ready' && view === 'tree' && (
        <div className="cat-tree">
          {roots.length === 0 && <p className="data-table__empty">No categories.</p>}
          <ul>
            {roots
              .filter((r) => !statusFilter || r.status === statusFilter)
              .sort((a, b) => a.displayOrder - b.displayOrder)
              .map((r) => <TreeNode key={r.id} node={r} byParent={byParent} depth={0} onEdit={(id) => { setEditId(id); setShowNew(false); }} />)}
          </ul>
        </div>
      )}

      {status === 'ready' && view === 'table' && (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Category name</th><th>Slug</th><th>Parent</th><th>Sort order</th>
                <th>Product count</th><th>Status</th><th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id} className="data-table__row-link" onClick={() => { setEditId(c.id); setShowNew(false); }}>
                  <td>
                    <span className="cat-cell" style={{ paddingLeft: c.parentId ? 18 : 0 }}>
                      {c.parentId && <span className="cat-cell__branch" aria-hidden="true">↳</span>}
                      <FolderIcon />{c.name}
                    </span>
                  </td>
                  <td><code>{c.slug}</code></td>
                  <td>{c.parentName || <span className="text-faint">—</span>}</td>
                  <td onClick={(e) => e.stopPropagation()}><OrderCell category={c} canWrite={canWrite} onSaved={refreshAll} /></td>
                  <td>
                    {c.productCount > 0
                      ? <Link to={`/products?category=${c.id}`} onClick={(e) => e.stopPropagation()}>{c.productCount}</Link>
                      : <span className="text-faint">0</span>}
                  </td>
                  <td><Badge>{c.status}</Badge></td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <RowMenu label={`Actions for ${c.name}`}>
                      <button type="button" role="menuitem" onClick={() => { setEditId(c.id); setShowNew(false); }}>Edit category</button>
                      <Link role="menuitem" to={`/products?category=${c.id}`}>View products</Link>
                      {canWrite && (
                        <button type="button" role="menuitem" disabled={statusBusy} onClick={() => changeStatus(c)}>
                          {c.status === 'ACTIVE' ? 'Archive' : 'Restore'}
                        </button>
                      )}
                    </RowMenu>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={7} className="data-table__empty">{anyFilter ? 'No categories match.' : 'No categories.'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </PageShell>
  );
}

function CategoryForm({ category, roots, onDone }) {
  const editing = Boolean(category);
  const [form, setForm] = useState({
    name: category?.name ?? '', slug: category?.slug ?? '', description: category?.description ?? '',
    parentId: category?.parentId ?? null, displayOrder: String(category?.displayOrder ?? 0),
    status: category?.status ?? 'ACTIVE',
  });
  const set = (k) => (v) => setForm((s) => ({ ...s, [k]: v }));
  const [save, { busy, error }] = useMutation((body) => (editing
    ? adminApi.catalog.updateCategory(category.id, body)
    : adminApi.catalog.createCategory(body)));
  const [del, { error: delErr }] = useMutation((confirmReferences) => adminApi.catalog.deleteCategory(category.id, { confirmReferences }));
  const [deleting, setDeleting] = useState(false);

  return (
    <form
      className="cat-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const body = {
          name: form.name.trim(),
          description: form.description.trim() || null,
          parentId: form.parentId || null,
          displayOrder: Number(form.displayOrder) || 0,
          status: form.status,
        };
        if (form.slug.trim() && form.slug.trim() !== category?.slug) body.slug = form.slug.trim();
        try { await save(body); onDone(); } catch { /* surfaced */ }
      }}
    >
      <h2 className="cat-form__title">{editing ? `Edit ${category.name}` : 'New category'}</h2>
      <div className="cat-form__grid">
        <FormField id="cat-name" label="Name" value={form.name} onChange={set('name')} required />
        <FormField id="cat-slug" label="Slug (leave blank to derive)" value={form.slug} onChange={set('slug')} />
        <Select id="cat-parent" label="Parent (top-level only)" value={form.parentId} onChange={set('parentId')}
          includeBlank blankLabel="— none (top level) —"
          options={roots.filter((r) => r.id !== category?.id).map((r) => [r.id, r.name])} />
        <FormField id="cat-order" label="Display order" type="number" value={form.displayOrder} onChange={set('displayOrder')} />
        <Select id="cat-status" label="Status" value={form.status} onChange={set('status')}
          options={[['ACTIVE', 'Active'], ['ARCHIVED', 'Archived']]} />
        <FormField id="cat-desc" label="Description" value={form.description} onChange={set('description')} />
      </div>
      {editing && <EntityUsage type="CATEGORY" id={category.id} />}
      {error && <InlineAlert tone="error">{error.message}</InlineAlert>}
      {delErr && <InlineAlert tone="error">{delErr.message}</InlineAlert>}
      <div className="cat-form__actions">
        <Button type="submit" busy={busy} disabled={!form.name.trim()}>{editing ? 'Save' : 'Create'}</Button>
        <Button variant="ghost" onClick={onDone}>Cancel</Button>
        {editing && (
          <button
            type="button"
            className="btn btn--danger btn--sm"
            onClick={() => setDeleting(true)}
          >
            Delete
          </button>
        )}
      </div>
      <EntityDeleteDialog
        open={deleting}
        type="CATEGORY"
        id={category?.id}
        name={category?.name}
        onCancel={() => setDeleting(false)}
        onConfirm={async (confirmReferences) => {
          try { await del(confirmReferences); setDeleting(false); onDone(); } catch { setDeleting(false); /* surfaced below the form */ }
        }}
      />
    </form>
  );
}

export default CategoriesPage;
