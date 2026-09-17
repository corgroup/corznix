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
import { RowsEditor, CellInput, DirtyPill } from '../components/ui/RowsEditor.jsx';
import { withRowKeys, stripRowKeys, useUnsavedGuard } from '../components/ui/rowHelpers.js';
import { adminApi } from '../api/adminApi.js';
import { useApiResource } from '../hooks/useApiResource.js';
import { useMutation } from '../features/catalog/useMutation.js';
import { useAuth } from '../auth/useAuth.js';
import { formatRelative } from '../utils/format.js';
import './SizeGuidesPage.css';

const STATUS_OPTIONS = [['DRAFT', 'Draft'], ['ACTIVE', 'Active'], ['ARCHIVED', 'Archived']];
const USED_OPTIONS = [['used', 'Used by products'], ['unused', 'Not used']];
const SORT_OPTIONS = [
  ['updated', 'Recently updated'],
  ['name', 'Name A–Z'],
  ['rows', 'Most rows'],
  ['usage', 'Most used'],
];

const GuideGlyph = () => (
  <svg className="sg-glyph" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <path d="M13 8h14l-3 4v20H16V12z" strokeLinejoin="round" />
    <path d="M13 8l-4 3 3 4M27 8l4 3-3 4" strokeLinejoin="round" />
    <path d="M15 20h10M15 25h10" strokeDasharray="1 2" />
  </svg>
);

function StatCard({ label, value, tone, active, onClick }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} className={`stat-card${tone ? ` stat-card--${tone}` : ''}`}
      aria-pressed={onClick ? active || undefined : undefined} onClick={onClick}>
      <p className="stat-card__label">{label}</p>
      <p className="stat-card__value">{value ?? '—'}</p>
    </Tag>
  );
}

// Reusable named size guides. Editing an ACTIVE guide affects every product
// mapped to it. Product <-> guide mapping is explicit (Product editor).
export function SizeGuidesPage() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('catalog.write');
  const { status, data, error, reload } = useApiResource(() => adminApi.catalog.sizeGuides());
  const facetsRes = useApiResource(() => adminApi.catalog.sizeGuideFacets());
  const [openId, setOpenId] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState(null);
  const [usedFilter, setUsedFilter] = useState(null);
  const [sort, setSort] = useState('updated');

  const guides = useMemo(() => data?.sizeGuides ?? [], [data]);
  const f = facetsRes.data;
  const refreshAll = () => { reload(); facetsRes.reload(); };

  const filtered = useMemo(() => {
    let list = [...guides];
    const needle = q.trim().toLowerCase();
    if (needle) list = list.filter((g) => g.name.toLowerCase().includes(needle) || (g.description || '').toLowerCase().includes(needle));
    if (statusFilter) list = list.filter((g) => g.status === statusFilter);
    if (usedFilter === 'used') list = list.filter((g) => g.usageCount > 0);
    if (usedFilter === 'unused') list = list.filter((g) => g.usageCount === 0);
    const cmp = {
      updated: (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
      name: (a, b) => a.name.localeCompare(b.name),
      rows: (a, b) => b.rowCount - a.rowCount,
      usage: (a, b) => b.usageCount - a.usageCount,
    }[sort];
    return list.sort(cmp);
  }, [guides, q, statusFilter, usedFilter, sort]);

  const anyFilter = Boolean(q.trim() || statusFilter || usedFilter);

  return (
    <PageShell
      title="Size Guides"
      description="Reusable garment measurement tables. A product page renders the guide that product is mapped to; the storefront's Size Guide page lists every ACTIVE guide."
      actions={canWrite ? <Button onClick={() => { setShowNew((v) => !v); setOpenId(null); }}>{showNew ? 'Close' : 'New size guide'}</Button> : null}
    >
      <div className="sg-strip">
        <StatCard label="Total guides" value={f?.total} tone="neutral"
          active={!anyFilter} onClick={() => { setQ(''); setStatusFilter(null); setUsedFilter(null); }} />
        <StatCard label="Active" value={f?.active} tone="good"
          active={statusFilter === 'ACTIVE'} onClick={() => setStatusFilter(statusFilter === 'ACTIVE' ? null : 'ACTIVE')} />
        <StatCard label="Inactive" value={f?.inactive} tone="neutral" />
        <StatCard label="Used by products" value={f?.usedByProducts} tone="neutral"
          active={usedFilter === 'used'} onClick={() => setUsedFilter(usedFilter === 'used' ? null : 'used')} />
        <StatCard label="Formats" value={f?.formats?.join(' · ') || '—'} tone="neutral" />
      </div>

      {showNew && canWrite && <NewGuide onCreated={() => { setShowNew(false); refreshAll(); }} />}

      <div className="sg-toolbar">
        <input className="sg-toolbar__search" type="search" placeholder="Search size guides…"
          value={q} onChange={(e) => setQ(e.target.value)} />
        <Select id="sg-f-status" label="Status" value={statusFilter} onChange={setStatusFilter}
          options={STATUS_OPTIONS} includeBlank blankLabel="Any status" />
        <Select id="sg-f-used" label="Used by" value={usedFilter} onChange={setUsedFilter}
          options={USED_OPTIONS} includeBlank blankLabel="Any" />
        <Select id="sg-f-sort" label="Sort by" value={sort} onChange={(v) => setSort(v || 'updated')} options={SORT_OPTIONS} />
        <a className="btn btn--secondary" href={adminApi.catalog.sizeGuidesExportUrl()}>Export CSV</a>
      </div>

      {status === 'loading' && <LoadingState label="Loading size guides…" />}
      {status === 'error' && <ErrorState message={error?.message} onRetry={reload} />}
      {status === 'ready' && (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Size guide</th><th>Format</th><th>Units</th><th>Rows</th>
                <th>Used by</th><th>Status</th><th>Updated</th><th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((g) => (
                <tr key={g.id} className="data-table__row-link" onClick={() => { setOpenId(g.id); setShowNew(false); }}>
                  <td>
                    <div className="sg-cell">
                      <span className="sg-cell__glyph"><GuideGlyph /></span>
                      <div>
                        <span className="sg-cell__name">{g.name}</span>
                        {g.description && <span className="sg-cell__desc">{g.description}</span>}
                        {g.columns?.length > 0 && (
                          <span className="sg-cell__cols">
                            {g.columns.map((c) => <span key={c} className="sg-col-chip">{c}</span>)}
                          </span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td>{g.format || 'Table'}</td>
                  <td>{g.unit}</td>
                  <td>{g.rowCount}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {g.usageCount > 0
                      ? <Link to={`/products?sizeGuide=assigned`}>{g.usageCount} product{g.usageCount === 1 ? '' : 's'}</Link>
                      : <span className="text-faint">0 products</span>}
                  </td>
                  <td><Badge>{g.status}</Badge></td>
                  <td className="text-faint">{formatRelative(g.updatedAt)}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <RowMenu label={`Actions for ${g.name}`}>
                      <button type="button" role="menuitem" onClick={() => { setOpenId(g.id); setShowNew(false); }}>Open</button>
                    </RowMenu>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={8} className="data-table__empty">{anyFilter ? 'No size guides match.' : 'No size guides yet.'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {openId && <GuideEditor id={openId} canWrite={canWrite} onChanged={refreshAll} onDeleted={() => { setOpenId(null); refreshAll(); }} />}
    </PageShell>
  );
}

function NewGuide({ onCreated }) {
  const [form, setForm] = useState({ name: '', unit: 'in', columns: 'size,chest,length' });
  const [create, { busy, error }] = useMutation((body) => adminApi.catalog.createSizeGuide(body));
  const set = (k) => (v) => setForm((s) => ({ ...s, [k]: v }));
  return (
    <form className="editor-form" style={{ maxWidth: 560, marginBottom: 24 }} onSubmit={async (e) => {
      e.preventDefault();
      const columns = form.columns.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean);
      await create({
        name: form.name.trim(), unit: form.unit, columns,
        rows: [{ size: 'M', displayOrder: 0, values: Object.fromEntries(columns.filter((c) => c !== 'size').map((c) => [c, 0])) }],
      });
      onCreated();
    }}>
      <FormField id="sg-name" label="Name" value={form.name} onChange={set('name')} required placeholder="Oversized T-Shirt" />
      <Select id="sg-unit" label="Unit" value={form.unit} onChange={set('unit')} options={[['in', 'in'], ['cm', 'cm']]} />
      <FormField id="sg-cols" label="Columns (comma-separated, include size)" value={form.columns} onChange={set('columns')} />
      {error && <InlineAlert tone="error">{error.message}</InlineAlert>}
      <Button type="submit" busy={busy} disabled={!form.name.trim()}>Create (as DRAFT)</Button>
    </form>
  );
}

function GuideEditor({ id, canWrite, onChanged, onDeleted }) {
  const { status, data, error, reload } = useApiResource(() => adminApi.catalog.getSizeGuide(id));
  if (status === 'loading') return <LoadingState label="Loading guide…" />;
  if (status === 'error') return <ErrorState message={error?.message} onRetry={reload} />;
  return <GuideEditorInner key={id} id={id} g={data} canWrite={canWrite} reload={reload} onChanged={onChanged} onDeleted={onDeleted} />;
}

function GuideEditorInner({ id, g, canWrite, reload, onChanged, onDeleted }) {
  const [meta, { error: metaErr }] = useMutation((body) => adminApi.catalog.updateSizeGuide(id, body));
  const [rowsMut, { error: rowsErr }] = useMutation((rows) => adminApi.catalog.setSizeGuideRows(id, rows));
  const [statusMut, { error: statusErr }] = useMutation((s) => adminApi.catalog.setSizeGuideStatus(id, s));
  const [del, { error: delErr }] = useMutation(() => adminApi.catalog.deleteSizeGuide(id));

  const measureCols = useMemo(() => g.columns.filter((c) => c !== 'size'), [g.columns]);
  const hydrate = () => withRowKeys(g.rows.map((r) => ({
    size: r.size,
    values: { ...(r.values || {}) },
    valuesCm: r.valuesCm ? { ...r.valuesCm } : null,
  })));
  const [rows, setRows] = useState(hydrate);
  const [showCm, setShowCm] = useState(() => g.rows.some((r) => r.valuesCm));
  const [notes, setNotes] = useState(g.notes ?? '');

  const rowsDirty = JSON.stringify(stripRowKeys(rows)) !== JSON.stringify(stripRowKeys(hydrate()));
  const notesDirty = (notes || '') !== (g.notes || '');
  useUnsavedGuard(rowsDirty || notesDirty);

  const setVal = (i, col, kind, v) => setRows((rs) => rs.map((r, j) => {
    if (j !== i) return r;
    const bag = { ...(r[kind] || {}) };
    if (v == null) delete bag[col]; else bag[col] = v;
    return { ...r, [kind]: kind === 'valuesCm' && Object.keys(bag).length === 0 ? null : bag };
  }));

  const saveRows = async () => {
    const payload = rows.map((r, i) => ({
      size: (r.size || '').trim(),
      displayOrder: i,
      values: r.values || {},
      ...(showCm || r.valuesCm ? { valuesCm: r.valuesCm || {} } : {}),
    }));
    await rowsMut(payload);
    reload(); onChanged();
  };

  const cols = [
    { key: 'size', label: 'Size', width: '110px', render: (row, patch, ctx) => (
      <CellInput value={row.size} onChange={(v) => patch({ size: v })} disabled={ctx.disabled} placeholder="M" ariaLabel={`Size label, row ${ctx.index + 1}`} />
    ) },
    ...measureCols.map((col) => ({
      key: col,
      label: `${col} (${g.unit})`,
      render: (row, _patch, ctx) => (
        <CellInput type="number" value={row.values?.[col] ?? ''} disabled={ctx.disabled}
          onChange={(v) => setVal(ctx.index, col, 'values', v)} ariaLabel={`${col} for ${row.size || `row ${ctx.index + 1}`}`} />
      ),
    })),
    ...(showCm ? measureCols.map((col) => ({
      key: `cm_${col}`,
      label: `${col} (cm)`,
      render: (row, _patch, ctx) => (
        <CellInput type="number" value={row.valuesCm?.[col] ?? ''} disabled={ctx.disabled}
          onChange={(v) => setVal(ctx.index, col, 'valuesCm', v)} ariaLabel={`${col} in cm for ${row.size || `row ${ctx.index + 1}`}`} />
      ),
    })) : []),
  ];

  return (
    <section className="dash-section" style={{ marginTop: 24 }}>
      <h2 className="dash-section__title">
        {g.name} — {g.unit} · columns: {g.columns.join(', ')}
        <span style={{ marginLeft: 10 }}><DirtyPill dirty={rowsDirty || notesDirty} /></span>
      </h2>
      <div className="editor-form" style={{ maxWidth: 900 }}>
        <div className="form-field">
          <label htmlFor={`sg-notes-${id}`}>Notes</label>
          <textarea id={`sg-notes-${id}`} rows={2} disabled={!canWrite} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        {canWrite && (
          <div className="editor-actions">
            <Button variant="secondary" disabled={!notesDirty} onClick={async () => { await meta({ notes: notes.trim() || null }); reload(); onChanged(); }}>Save notes</Button>
          </div>
        )}
        {metaErr && <InlineAlert tone="error">{metaErr.message}</InlineAlert>}

        <label className="editor-form__label" style={{ marginTop: 8 }}>Measurements</label>
        {measureCols.length === 0 && <InlineAlert tone="info">This guide has no measurement columns. Recreate it with columns to add measurements.</InlineAlert>}
        <RowsEditor
          rows={rows}
          onChange={setRows}
          columns={cols}
          makeRow={() => ({ size: '', values: {}, valuesCm: showCm ? {} : null })}
          addLabel="Add size"
          minRows={0}
          disabled={!canWrite || measureCols.length === 0}
          emptyLabel="No sizes yet — add one."
        />
        <label className="form-field" style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={showCm} disabled={!canWrite} onChange={(e) => setShowCm(e.target.checked)} />
          Also capture centimetre values
        </label>
        {canWrite && (
          <div className="editor-actions">
            <Button disabled={!rowsDirty} onClick={saveRows}>Save measurements</Button>
            <Button variant="secondary" disabled={!rowsDirty} onClick={() => { setRows(hydrate()); }}>Discard changes</Button>
          </div>
        )}
        {rowsErr && <InlineAlert tone="error">{rowsErr.message}</InlineAlert>}

        {canWrite && (
          <div className="editor-actions" style={{ marginTop: 16 }}>
            {['DRAFT', 'ACTIVE', 'ARCHIVED'].filter((s) => s !== g.status).map((s) => (
              <Button key={s} variant="secondary" onClick={async () => { await statusMut(s); reload(); onChanged(); }}>Set {s}</Button>
            ))}
            {/* The guide is gone once this succeeds: close its editor rather than
                leave Save and Set buttons pointing at a deleted record. */}
            <Button variant="danger" onClick={async () => { if (confirm('Delete this size guide?')) { await del(); onDeleted(); } }}>Delete</Button>
          </div>
        )}
        {statusErr && <InlineAlert tone="error">{statusErr.message}</InlineAlert>}
        {delErr && <InlineAlert tone="error">{delErr.message}</InlineAlert>}
      </div>
    </section>
  );
}

export default SizeGuidesPage;
