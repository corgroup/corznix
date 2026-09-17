import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PageShell } from '../layout/PageShell.jsx';
import { Button } from '../components/ui/Button.jsx';
import { FormField } from '../components/ui/FormField.jsx';
import { InlineAlert } from '../components/feedback/InlineAlert.jsx';
import { LoadingState } from '../components/feedback/LoadingState.jsx';
import { ErrorState } from '../components/feedback/ErrorState.jsx';
import { adminApi } from '../api/adminApi.js';
import { useApiResource } from '../hooks/useApiResource.js';
import { useMutation } from '../features/catalog/useMutation.js';
import { useAuth } from '../auth/useAuth.js';

function EditForm({ warehouse, canManage, onSaved }) {
  const [form, setForm] = useState({
    name: warehouse.name || '', addressLine1: warehouse.addressLine1 || '', city: warehouse.city || '',
    state: warehouse.state || '', postalCode: warehouse.postalCode || '', contactName: warehouse.contactName || '',
    contactPhone: warehouse.contactPhone || '', contactPhoneAlt: warehouse.contactPhoneAlt || '',
    priority: String(warehouse.priority ?? 100),
  });
  const [save, { busy, error }] = useMutation((body) => adminApi.warehouses.update(warehouse.id, body));
  const [done, setDone] = useState(false);
  const set = (key) => (value) => { setForm((s) => ({ ...s, [key]: value })); setDone(false); };

  const submit = async (event) => {
    event.preventDefault();
    await save({
      name: form.name.trim(), addressLine1: form.addressLine1.trim(), city: form.city.trim(),
      state: form.state.trim(), postalCode: form.postalCode.trim() || undefined,
      contactName: form.contactName.trim(), contactPhone: form.contactPhone.trim(),
      contactPhoneAlt: form.contactPhoneAlt.trim(),
      priority: form.priority === '' ? undefined : Number(form.priority),
    });
    setDone(true);
    onSaved();
  };

  return (
    <form className="editor-form" onSubmit={submit} style={{ maxWidth: 560 }}>
      <FormField id="name" label="Name" value={form.name} onChange={set('name')} disabled={!canManage} required />
      <FormField id="addressLine1" label="Address" value={form.addressLine1} onChange={set('addressLine1')} disabled={!canManage} />
      <FormField id="city" label="City" value={form.city} onChange={set('city')} disabled={!canManage} />
      <FormField id="state" label="State" value={form.state} onChange={set('state')} disabled={!canManage} />
      <FormField id="postalCode" label="PIN code" value={form.postalCode} onChange={set('postalCode')} disabled={!canManage} />
      {/* Pickup contact — the number a carrier's pickup agent calls when they
          cannot find, or cannot get into, the warehouse. Without it Ready for
          Pickup is refused, so it is grouped with its own explanation rather
          than sitting among the address fields as two more inputs. */}
      <fieldset className="wh-contact">
        <legend>Pickup contact</legend>
        <p className="wh-contact__note">
          The carrier&apos;s pickup agent calls this number. A warehouse cannot be enabled for
          fulfilment, and no pickup can be requested, without a contact person and a valid mobile.
        </p>
        {warehouse.pickupContact && !warehouse.pickupContact.ready && (
          <InlineAlert tone="warning">
            {warehouse.pickupContact.message || 'This warehouse has no usable pickup contact yet.'}
          </InlineAlert>
        )}
        <FormField id="contactName" label="Contact person" value={form.contactName}
          onChange={set('contactName')} disabled={!canManage} required />
        <FormField id="contactPhone" label="Mobile number (required)" value={form.contactPhone}
          onChange={set('contactPhone')} disabled={!canManage} required placeholder="9278092710" />
        <FormField id="contactPhoneAlt" label="Alternate mobile (optional)" value={form.contactPhoneAlt}
          onChange={set('contactPhoneAlt')} disabled={!canManage} placeholder="Optional" />
        <p className="wh-contact__note">
          Type a 10-digit Indian mobile — it is stored as +91XXXXXXXXXX and converted to whatever
          format each carrier needs.
        </p>
      </fieldset>
      <FormField id="priority" label="Priority (lower = preferred)" type="number" value={form.priority} onChange={set('priority')} disabled={!canManage} />
      {error && <InlineAlert tone="error">{error.message}</InlineAlert>}
      {done && <InlineAlert tone="info">Saved.</InlineAlert>}
      {canManage && (
        <div className="editor-actions"><Button type="submit" busy={busy}>Save changes</Button></div>
      )}
    </form>
  );
}

function InventoryPanel({ warehouseId, canAdjust }) {
  const { status, data, error, reload } = useApiResource(() => adminApi.warehouses.inventory(warehouseId));
  const [target, setTarget] = useState(null); // { skuId }
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');
  const [adjust, { busy, error: adjustError }] = useMutation((body) => adminApi.warehouses.adjustInventory(warehouseId, body));

  const submit = async (event) => {
    event.preventDefault();
    await adjust({ skuId: target.skuId, delta: Number(delta), reason: reason.trim() });
    setTarget(null); setDelta(''); setReason('');
    reload();
  };

  if (status === 'loading') return <LoadingState label="Loading inventory…" />;
  if (status === 'error') return <ErrorState message={error?.message} onRetry={reload} />;
  const items = data?.items ?? [];

  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr><th>SKU</th><th>Product</th><th>On hand</th><th>Reserved</th><th>Available</th>{canAdjust && <th />}</tr>
        </thead>
        <tbody>
          {items.map((row) => (
            <tr key={row.skuId}>
              <td>{row.sku}</td>
              <td>{row.productName ? `${row.productName}${row.colorName ? ` · ${row.colorName}` : ''}${row.size ? ` · ${row.size}` : ''}` : '—'}</td>
              <td>{row.onHand}</td>
              <td>{row.reserved}</td>
              <td>{row.available}</td>
              {canAdjust && (
                <td><Button variant="secondary" onClick={() => { setTarget({ skuId: row.skuId, sku: row.sku }); setDelta(''); setReason(''); }}>Adjust</Button></td>
              )}
            </tr>
          ))}
          {items.length === 0 && (
            <tr><td colSpan={canAdjust ? 6 : 5} className="data-table__empty">No inventory rows at this warehouse yet.</td></tr>
          )}
        </tbody>
      </table>

      {target && canAdjust && (
        <form className="editor-form" onSubmit={submit} style={{ maxWidth: 480, marginTop: 16 }}>
          <p className="page-shell__description">Adjust on-hand for <strong>{target.sku}</strong>. Available is always derived — you can only change on-hand.</p>
          <FormField id="delta" label="Delta (+ receive / − remove)" type="number" value={delta} onChange={setDelta} required />
          <FormField id="reason" label="Reason" value={reason} onChange={setReason} required placeholder="Stock count correction, damage, receipt…" />
          {adjustError && <InlineAlert tone="error">{adjustError.message}</InlineAlert>}
          <div className="editor-actions">
            <Button type="submit" busy={busy} disabled={!delta || Number(delta) === 0 || !reason.trim()}>Apply adjustment</Button>
            <Button type="button" variant="ghost" onClick={() => setTarget(null)}>Cancel</Button>
          </div>
        </form>
      )}
    </div>
  );
}

function StaffPanel({ warehouse, canManage, onChanged }) {
  const [staffUserId, setStaffUserId] = useState('');
  const [assign, { busy, error }] = useMutation((id) => adminApi.warehouses.assignStaff(warehouse.id, id));
  const [unassign, { busy: unbusy }] = useMutation((id) => adminApi.warehouses.unassignStaff(warehouse.id, id));
  const staff = warehouse.assignedStaff ?? [];

  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead><tr><th>Name</th><th>Email</th><th>Role</th>{canManage && <th />}</tr></thead>
        <tbody>
          {staff.map((member) => (
            <tr key={member.id}>
              <td>{member.firstName} {member.lastName}</td>
              <td>{member.email}</td>
              <td>{member.role}</td>
              {canManage && (
                <td><Button variant="danger" busy={unbusy} onClick={async () => { await unassign(member.id); onChanged(); }}>Remove</Button></td>
              )}
            </tr>
          ))}
          {staff.length === 0 && (
            <tr><td colSpan={canManage ? 4 : 3} className="data-table__empty">No staff scoped to this warehouse (unassigned staff are unscoped).</td></tr>
          )}
        </tbody>
      </table>
      {canManage && (
        <form
          className="editor-form"
          style={{ maxWidth: 480, marginTop: 16 }}
          onSubmit={async (event) => { event.preventDefault(); await assign(staffUserId.trim()); setStaffUserId(''); onChanged(); }}
        >
          <FormField id="staffUserId" label="Assign staff by user id" value={staffUserId} onChange={setStaffUserId} placeholder="UUID from Staff / Access" />
          {error && <InlineAlert tone="error">{error.message}</InlineAlert>}
          <div className="editor-actions"><Button type="submit" busy={busy} disabled={!staffUserId.trim()}>Assign</Button></div>
        </form>
      )}
    </div>
  );
}

// Phase 2 §35 — the exact case/space-sensitive name each carrier expects for
// this warehouse as a pickup location. Entered from a real provider warehouse
// registration — never guessed.
const PICKUP_MODE_LABEL = { API: 'API', AUTO: 'Auto-pickup', MANUAL_PANEL: 'Manual (panel)' };

function CarrierLocationsPanel({ warehouse, canManage, onChanged }) {
  const existing = warehouse.providerLocations ?? [];
  const [providerCode, setProviderCode] = useState('DELHIVERY');
  const [identifier, setIdentifier] = useState('');
  const [returnIdentifier, setReturnIdentifier] = useState('');
  const [notes, setNotes] = useState('');
  const [pickupMode, setPickupMode] = useState('MANUAL_PANEL');
  const [mode, setMode] = useState('register');
  const [panelVerified, setPanelVerified] = useState(false);
  const [save, { busy, error }] = useMutation((body) => adminApi.warehouses.setProviderLocation(warehouse.id, providerCode, body));
  const [remove, { busy: rmBusy }] = useMutation((code) => adminApi.warehouses.removeProviderLocation(warehouse.id, code));

  const submit = async (event) => {
    event.preventDefault();
    await save({
      mode,
      identifier, // sent verbatim — case + spaces matter
      returnIdentifier: returnIdentifier.trim() || null,
      notes: notes.trim() || undefined,
      pickupMode,
      ...(mode === 'link' ? { panelVerified } : {}),
    });
    setIdentifier(''); setReturnIdentifier(''); setNotes(''); setPickupMode('MANUAL_PANEL'); setPanelVerified(false);
    onChanged();
  };

  return (
    <div className="table-wrap">
      <p className="page-shell__description">
        The pickup-location name each carrier has registered for this warehouse. It must match the carrier&apos;s records
        <strong> exactly</strong> (case and spaces) — the manifest is rejected otherwise.
      </p>
      <p className="page-shell__description">
        <strong>CORCOTTON is the source of truth.</strong> Carriers offer no way to read a warehouse back, so a change
        made directly in the carrier&apos;s panel cannot be detected here and will silently disagree with this page.
        Make every warehouse change in CORCOTTON and let it push. A pickup name also cannot be renamed once registered,
        so this warehouse&apos;s code locks while a mapping exists.
      </p>
      <table className="data-table">
        <thead><tr><th>Carrier</th><th>Pickup identifier</th><th>Pickup mode</th><th>Return identifier</th><th>Registered</th>{canManage && <th />}</tr></thead>
        <tbody>
          {existing.map((row) => (
            <tr key={row.providerCode}>
              <td>{row.providerCode}</td>
              <td><code>{row.identifier}</code></td>
              <td>{PICKUP_MODE_LABEL[row.pickupMode] || row.pickupMode || '—'}</td>
              <td>{row.returnIdentifier ? <code>{row.returnIdentifier}</code> : '—'}</td>
              <td>
                {row.registeredAt
                  ? new Date(row.registeredAt).toLocaleDateString()
                  : row.panelVerifiedAt
                    ? <span className="pill pill--muted" title={`Checked in the carrier panel on ${new Date(row.panelVerifiedAt).toLocaleDateString()}. Not an API registration.`}>panel-verified</span>
                    : <span className="pill pill--muted">not confirmed</span>}
              </td>
              {canManage && (
                <td><Button variant="danger" busy={rmBusy} onClick={async () => { await remove(row.providerCode); onChanged(); }}>Remove</Button></td>
              )}
            </tr>
          ))}
          {existing.length === 0 && (
            <tr><td colSpan={canManage ? 6 : 5} className="data-table__empty">No carrier pickup locations mapped — real shipment booking is blocked until one is set.</td></tr>
          )}
        </tbody>
      </table>
      {canManage && (
        <form className="editor-form" onSubmit={submit} style={{ maxWidth: 520, marginTop: 16 }}>
          <label htmlFor="wpl-provider">Carrier</label>
          <select id="wpl-provider" value={providerCode} onChange={(e) => setProviderCode(e.target.value)}>
            <option value="DELHIVERY">Delhivery</option>
            <option value="BLUE_DART">Blue Dart</option>
            <option value="DTDC">DTDC</option>
          </select>
          <label htmlFor="wpl-mode-kind">How this mapping is created</label>
          <select id="wpl-mode-kind" value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="register">Register at the carrier — creates the pickup location there now</option>
            <option value="link">Link an existing name — it already exists in the carrier panel</option>
          </select>
          <p className="wh-contact__note">
            {mode === 'register'
              ? 'CORCOTTON creates the pickup location using this warehouse’s address and phone, and saves the mapping only once the carrier confirms it.'
              : 'Nothing is sent to the carrier. The name is stored exactly as typed and shown as “not confirmed”, because carriers offer no read API to check it against.'}
          </p>
          <FormField id="wpl-identifier" label="Pickup identifier (exact)" value={identifier} onChange={setIdentifier} required placeholder="e.g. CORCOTTON_ND_01" />
          {mode === 'link' && (
            <>
              <label htmlFor="wpl-panel-verified" style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 400 }}>
                <input id="wpl-panel-verified" type="checkbox" checked={panelVerified}
                  onChange={(e) => setPanelVerified(e.target.checked)} style={{ width: 'auto', margin: 0 }} />
                I opened the carrier&apos;s panel and read this exact name there
              </label>
              <p className="wh-contact__note">
                Tick this only if you actually looked. It does not mark the location registered — the carrier has
                still confirmed nothing to us — it records that a person checked, so the mapping stops being reported
                alongside names nobody has ever verified.
              </p>
            </>
          )}
          <FormField id="wpl-return" label="Return identifier (optional)" value={returnIdentifier} onChange={setReturnIdentifier} />
          <label htmlFor="wpl-mode">How pickups are raised</label>
          <select id="wpl-mode" value={pickupMode} onChange={(e) => setPickupMode(e.target.value)}>
            <option value="MANUAL_PANEL">Manual — staff raise it in the carrier&apos;s panel</option>
            <option value="API">API — CORCOTTON requests the pickup automatically</option>
            <option value="AUTO">Auto — the carrier account is on auto-pickup</option>
          </select>
          <p className="wh-contact__note">
            Ready for Pickup only calls the carrier on <strong>API</strong>. On Manual and Auto the parcel is
            marked awaiting collection and no request is sent.
          </p>
          <FormField id="wpl-notes" label="Notes (optional)" value={notes} onChange={setNotes} />
          {error && <InlineAlert tone="error">{error.message}</InlineAlert>}
          <div className="editor-actions"><Button type="submit" busy={busy} disabled={!identifier}>Save carrier location</Button></div>
        </form>
      )}
    </div>
  );
}

export function WarehouseDetailPage() {
  const { id } = useParams();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('warehouse.manage');
  const canAdjust = hasPermission('inventory.adjust');
  const { status, data, error, reload } = useApiResource(() => adminApi.warehouses.get(id));
  const [setStatusMut, { busy: statusBusy, error: statusError }] = useMutation((next) => adminApi.warehouses.setStatus(id, next));
  const [tab, setTab] = useState('details');

  if (status === 'loading') return <PageShell title="Warehouse"><LoadingState label="Loading…" /></PageShell>;
  if (status === 'error') return <PageShell title="Warehouse"><ErrorState message={error?.message} onRetry={reload} /></PageShell>;

  const warehouse = data;
  const toggle = async () => { await setStatusMut(warehouse.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE'); reload(); };

  return (
    <PageShell
      title={`${warehouse.code} · ${warehouse.name}`}
      description={<><Link to="/warehouses">← All warehouses</Link> · <span className={`pill pill--${warehouse.status === 'ACTIVE' ? 'good' : 'muted'}`}>{warehouse.status}</span></>}
      actions={canManage ? <Button variant={warehouse.status === 'ACTIVE' ? 'warning' : 'success'} busy={statusBusy} onClick={toggle}>{warehouse.status === 'ACTIVE' ? 'Disable' : 'Enable'}</Button> : null}
    >
      {statusError && <InlineAlert tone="error">{statusError.message}</InlineAlert>}
      <div className="tab-bar" style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {['details', 'inventory', 'staff', 'carriers'].map((key) => (
          <Button key={key} variant={tab === key ? 'primary' : 'secondary'} onClick={() => setTab(key)}>
            {key[0].toUpperCase() + key.slice(1)}
          </Button>
        ))}
      </div>

      {tab === 'details' && <EditForm warehouse={warehouse} canManage={canManage} onSaved={reload} />}
      {tab === 'inventory' && <InventoryPanel warehouseId={warehouse.id} canAdjust={canAdjust} />}
      {tab === 'staff' && <StaffPanel warehouse={warehouse} canManage={canManage} onChanged={reload} />}
      {tab === 'carriers' && <CarrierLocationsPanel warehouse={warehouse} canManage={canManage} onChanged={reload} />}
    </PageShell>
  );
}

export default WarehouseDetailPage;
