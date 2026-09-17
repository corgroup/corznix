import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PageShell } from '../layout/PageShell.jsx';
import { Button } from '../components/ui/Button.jsx';
import { FormField } from '../components/ui/FormField.jsx';
import { Select } from '../components/ui/Select.jsx';
import { Badge } from '../components/ui/Badge.jsx';
import { StatStrip } from '../components/ui/StatStrip.jsx';
import { InlineAlert } from '../components/feedback/InlineAlert.jsx';
import { LoadingState } from '../components/feedback/LoadingState.jsx';
import { ErrorState } from '../components/feedback/ErrorState.jsx';
import { adminApi } from '../api/adminApi.js';
import { useApiResource } from '../hooks/useApiResource.js';
import { useMutation } from '../features/catalog/useMutation.js';
import { useAuth } from '../auth/useAuth.js';

const EMPTY = { code: '', name: '', city: '', state: '', postalCode: '', priority: '100' };

// The same three findings the warehouse's own Carriers panel is built from, so
// the list and the detail page can never disagree about a warehouse's carrier
// readiness. No finding = a mapping exists and the carrier confirmed it.
const CARRIER_CELL = {
  NO_PICKUP_MAPPING: ['bad', 'Not mapped', 'No carrier pickup location — booking a shipment from here will fail.'],
  NO_PICKUP_MAPPING_INFO: ['muted', 'Not mapped', 'No carrier pickup location. Not blocking while the warehouse is disabled, but it must be mapped before it can ship.'],
  MAPPING_INACTIVE: ['warn', 'Mapping inactive', 'The pickup mapping exists but is not active.'],
  NEVER_REGISTERED_VIA_API: ['warn', 'Not confirmed', 'The pickup name was typed by hand and the carrier never confirmed it — it may not match the carrier panel.'],
  PANEL_VERIFIED_NOT_API_REGISTERED: ['muted', 'Panel-verified', 'Someone checked this name in the carrier panel. CORCOTTON did not register it through the API, so it cannot be confirmed programmatically.'],
  ORPHANED_MAPPING: ['warn', 'Orphaned', 'The mapping points at a warehouse that no longer exists.'],
};

function CarrierPickupCell({ finding, known }) {
  if (!known) return <span className="text-faint">—</span>;
  if (!finding) return <Badge tone="good">Registered</Badge>;
  const cellKey = finding.severity === 'INFO' ? `${finding.issue}_INFO` : finding.issue;
  const [tone, label, hint] = CARRIER_CELL[cellKey] || CARRIER_CELL[finding.issue] || ['warn', finding.issue, finding.detail];
  return <span title={hint}><Badge tone={tone}>{label}</Badge></span>;
}
const BoxIcon = () => (
  <svg className="wb-empty__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7l9-4 9 4-9 4-9-4zM3 7v10l9 4 9-4V7M12 11v10" />
  </svg>
);

export function WarehousesPage() {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('warehouse.manage');
  const { status, data, error, reload } = useApiResource(() => adminApi.warehouses.list());
  // Carrier readiness for the same warehouses, from the same backend check the
  // warehouse's own Carriers panel reflects — so this list can never say a
  // warehouse is fine while its pickup mapping is missing or unconfirmed.
  const { data: sync } = useApiResource(() => adminApi.warehouses.providerSyncStatus());
  const [form, setForm] = useState(EMPTY);
  const [showCreate, setShowCreate] = useState(false);
  const [create, { busy, error: createError }] = useMutation((body) => adminApi.warehouses.create(body));

  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState(null);
  const [cityFilter, setCityFilter] = useState(null);
  const [sort, setSort] = useState('name');

  const warehouses = useMemo(() => data?.warehouses ?? [], [data]);
  const cities = useMemo(() => [...new Set(warehouses.map((w) => w.city).filter(Boolean))].sort(), [warehouses]);
  const set = (key) => (value) => setForm((s) => ({ ...s, [key]: value }));

  const filtered = useMemo(() => {
    let list = [...warehouses];
    const n = q.trim().toLowerCase();
    if (n) list = list.filter((w) => `${w.code} ${w.name} ${w.city || ''}`.toLowerCase().includes(n));
    if (statusFilter) list = list.filter((w) => w.status === statusFilter);
    if (cityFilter) list = list.filter((w) => w.city === cityFilter);
    const cmp = {
      name: (a, b) => a.name.localeCompare(b.name),
      name_desc: (a, b) => b.name.localeCompare(a.name),
      priority: (a, b) => a.priority - b.priority,
    }[sort];
    return list.sort(cmp);
  }, [warehouses, q, statusFilter, cityFilter, sort]);

  const facets = useMemo(() => ({
    total: warehouses.length,
    active: warehouses.filter((w) => w.status === 'ACTIVE').length,
    inactive: warehouses.filter((w) => w.status !== 'ACTIVE').length,
    cities: cities.length,
  }), [warehouses, cities]);

  // One finding per warehouse — the most severe wins, because a warehouse with
  // no mapping at all is not also worth reporting as "unconfirmed".
  const carrierByWarehouse = useMemo(() => {
    const map = new Map();
    for (const f of sync?.findings ?? []) {
      const held = map.get(f.warehouseId);
      if (!held || (held.severity !== 'BLOCKING' && f.severity === 'BLOCKING')) map.set(f.warehouseId, f);
    }
    return map;
  }, [sync]);
  const blockingCount = useMemo(
    () => (sync?.findings ?? []).filter((f) => f.severity === 'BLOCKING' && warehouses.some((w) => w.id === f.warehouseId)).length,
    [sync, warehouses],
  );

  const submit = async (event) => {
    event.preventDefault();
    const created = await create({
      code: form.code.trim(),
      name: form.name.trim(),
      city: form.city.trim() || undefined,
      state: form.state.trim() || undefined,
      postalCode: form.postalCode.trim() || undefined,
      priority: form.priority === '' ? undefined : Number(form.priority),
    });
    setForm(EMPTY);
    setShowCreate(false);
    navigate(`/warehouses/${created.id}`);
  };

  return (
    <PageShell
      title="Warehouses"
      description="Origin warehouses for inventory, allocation and fulfilment. Adding a warehouse is data only — the allocation engine adapts with no code change."
      actions={canManage ? <Button onClick={() => setShowCreate((v) => !v)}>{showCreate ? 'Close' : 'New warehouse'}</Button> : null}
    >
      <StatStrip cards={[
        { label: 'Total warehouses', value: facets.total, hint: 'All locations', tone: 'neutral', active: !q && !statusFilter && !cityFilter, onClick: () => { setQ(''); setStatusFilter(null); setCityFilter(null); } },
        { label: 'Active', value: facets.active, hint: 'Allocating stock', tone: 'good', active: statusFilter === 'ACTIVE', onClick: () => setStatusFilter(statusFilter === 'ACTIVE' ? null : 'ACTIVE') },
        { label: 'Inactive', value: facets.inactive, tone: 'neutral' },
        { label: 'Cities', value: facets.cities, hint: 'Distinct locations', tone: 'neutral' },
      ]} />

      {blockingCount > 0 && (
        <InlineAlert tone="error">
          {blockingCount === 1 ? '1 active warehouse has' : `${blockingCount} active warehouses have`} no carrier pickup
          location. Shipments cannot be booked from {blockingCount === 1 ? 'it' : 'them'} until one is mapped — open the
          warehouse and use its Carriers panel.
        </InlineAlert>
      )}

      {showCreate && canManage && (
        <form className="editor-form" onSubmit={submit} style={{ maxWidth: 560, marginBottom: 24 }}>
          <FormField id="code" label="Code" value={form.code} onChange={set('code')} required placeholder="WH-LUCKNOW" />
          <FormField id="name" label="Name" value={form.name} onChange={set('name')} required />
          <FormField id="city" label="City" value={form.city} onChange={set('city')} />
          <FormField id="state" label="State" value={form.state} onChange={set('state')} />
          <FormField id="postalCode" label="PIN code" value={form.postalCode} onChange={set('postalCode')} placeholder="226001" />
          <FormField id="priority" label="Priority (lower = preferred)" type="number" value={form.priority} onChange={set('priority')} />
          {createError && <InlineAlert tone="error">{createError.message}</InlineAlert>}
          <div className="editor-actions">
            <Button type="submit" busy={busy} disabled={!form.code.trim() || !form.name.trim()}>Create warehouse</Button>
          </div>
        </form>
      )}

      <div className="wb-toolbar">
        <input className="wb-toolbar__search" type="search" placeholder="Search warehouses by code, name or city…"
          value={q} onChange={(e) => setQ(e.target.value)} />
        <Select id="wh-status" label="Status" value={statusFilter} onChange={setStatusFilter}
          options={[['ACTIVE', 'Active'], ['INACTIVE', 'Inactive']]} includeBlank blankLabel="Any status" />
        <Select id="wh-city" label="City" value={cityFilter} onChange={setCityFilter}
          options={cities.map((c) => [c, c])} includeBlank blankLabel="Any city" />
        <Select id="wh-sort" label="Sort by" value={sort} onChange={(v) => setSort(v || 'name')}
          options={[['name', 'Name (A–Z)'], ['name_desc', 'Name (Z–A)'], ['priority', 'Priority']]} />
      </div>

      {status === 'loading' && <LoadingState label="Loading warehouses…" />}
      {status === 'error' && <ErrorState message={error?.message} onRetry={reload} />}
      {status === 'ready' && (
        warehouses.length === 0 ? (
          <div className="wb-empty">
            <BoxIcon />
            <p className="wb-empty__title">No warehouses yet</p>
            <p className="wb-empty__body">Add your first warehouse to start managing inventory, allocation and fulfilment.</p>
            {canManage && (
              <div className="wb-empty__actions">
                <Button onClick={() => setShowCreate(true)}>New warehouse</Button>
              </div>
            )}
          </div>
        ) : (
          <>
            <p className="wb-count">{filtered.length} of {warehouses.length} warehouse{warehouses.length === 1 ? '' : 's'}</p>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr><th>Code</th><th>Name</th><th>City</th><th>Priority</th><th>Status</th><th>Carrier pickup</th><th aria-label="Actions" /></tr>
                </thead>
                <tbody>
                  {filtered.map((w) => (
                    <tr key={w.id} className="data-table__row-link" onClick={() => navigate(`/warehouses/${w.id}`)}>
                      <td><Link to={`/warehouses/${w.id}`} onClick={(e) => e.stopPropagation()}>{w.code}</Link></td>
                      <td>{w.name}</td>
                      <td>{w.city || <span className="text-faint">—</span>}</td>
                      <td>{w.priority}</td>
                      <td><Badge>{w.status}</Badge></td>
                      <td><CarrierPickupCell finding={carrierByWarehouse.get(w.id)} known={Boolean(sync)} /></td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <Link className="linkish" to={`/warehouses/${w.id}`}>Open</Link>
                      </td>
                    </tr>
                  ))}
                  {filtered.length === 0 && (
                    <tr><td colSpan={7} className="data-table__empty">No warehouses match.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            {data?.scope === 'ASSIGNED' && (
              <p className="page-shell__description">Showing only the warehouses you are assigned to.</p>
            )}
          </>
        )
      )}

      <div className="wb-about">
        <svg className="wb-about__icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" strokeLinecap="round" /></svg>
        <span><strong>About warehouses</strong>Warehouses are origin locations for inventory. The allocation engine automatically adapts — no code changes required.</span>
      </div>
    </PageShell>
  );
}

export default WarehousesPage;
