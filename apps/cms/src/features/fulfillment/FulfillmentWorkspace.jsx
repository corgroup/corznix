import { useState } from 'react';
import { Button } from '../../components/ui/Button.jsx';
import { Dialog } from '../../components/ui/Dialog.jsx';
import { InlineAlert } from '../../components/feedback/InlineAlert.jsx';
import { adminApi } from '../../api/adminApi.js';
import { useMutation, succeeded } from '../catalog/useMutation.js';
import { ShippingLabelPreview } from './ShippingLabelPreview.jsx';
import './FulfillmentWorkspace.css';

// The one fulfilment surface.
//
// The operator never navigates: status, primary action, shipment facts and
// documents all change in place. Data entry happens in a modal so the page
// underneath keeps its context.
//
// There is deliberately NO transition graph in this file. The backend returns
// `nextOperatorAction` and this renders it. The previous version of this page
// carried its own copy and it had already drifted from the server's.

const ACTION_ICON = { CONFIRM_ORDER: '✓', START_PREPARING: '▶', MANIFEST_SHIPMENT: '⬢', READY_FOR_PICKUP: '⇧' };

// What the operator is waiting on when there is no action to take. Business
// language: nobody in a warehouse needs to read "labelStatus === PENDING".
const WAITING_COPY = {
  SHIPMENT: 'Waiting for a shipment to be created for this order.',
  RECONCILE: 'A booking attempt had an unknown outcome — reconcile it with the carrier before continuing.',
  LABEL: 'Waiting for the carrier to return the shipping label.',
  CARRIER: 'The delivery partner has the parcel. Updates arrive automatically.',
};

/** Local calendar date — toISOString() is UTC and names yesterday before 05:30 IST. */
function todayLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const MODE_LABEL = { STANDARD: 'Surface', SURFACE: 'Surface', EXPRESS: 'Express', OWNER_DELIVERY: 'Owner delivery' };
const money = (m) => (m == null ? '—' : `₹${(Number(m) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`);

function ProgressRail({ progress }) {
  if (!progress || progress.cancelled) return null;
  return (
    <ol className="fw-rail" aria-label="Fulfilment progress">
      {progress.stages.map((stage, i) => {
        const state = i < progress.currentIndex ? 'done' : i === progress.currentIndex ? 'current' : 'todo';
        return (
          <li key={stage} className={`fw-rail__step fw-rail__step--${state}`}>
            <span className="fw-rail__dot" aria-hidden="true">{state === 'done' ? '✓' : ''}</span>
            <span className="fw-rail__label">{stage}</span>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Manifest — the only place the operator types anything about the parcel.
// ---------------------------------------------------------------------------
// mm is the wire unit everywhere — the manifest API, package_snapshot_json,
// and the Delhivery payload all store/expect millimetres, and that contract
// is untouched here. Centimetres are only how the operator TYPES a
// measurement; nobody measuring a box with a tape thinks in mm.
const mmToCm = (mm) => (mm === '' || mm == null ? '' : String(Number(mm) / 10));
const cmToMm = (cm) => Math.round(Number(cm) * 10);

function ManifestDialog({ open, onClose, order, shipment, warehouse, onDone }) {
  const pkg = shipment?.package || {};
  const [form, setForm] = useState({
    weightGrams: pkg.weightGrams ?? pkg.calculatedItemWeightGrams ?? '',
    lengthCm: mmToCm(pkg.lengthMm), widthCm: mmToCm(pkg.widthMm), heightCm: mmToCm(pkg.heightMm),
  });
  const [run, { busy, error }] = useMutation(() => adminApi.orders.manifestShipment(shipment.id, {
    weightGrams: Number(form.weightGrams),
    lengthMm: cmToMm(form.lengthCm),
    widthMm: cmToMm(form.widthCm),
    heightMm: cmToMm(form.heightCm),
    idempotencyKey: `manifest:${shipment.id}:${form.weightGrams}x${form.lengthCm}x${form.widthCm}x${form.heightCm}`,
  }));
  const set = (k) => (e) => setForm((s) => ({ ...s, [k]: e.target.value }));
  const complete = ['weightGrams', 'lengthCm', 'widthCm', 'heightCm'].every((k) => Number(form[k]) > 0);
  const mode = MODE_LABEL[order.shippingMethod] || order.shippingMethod || '—';

  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title="Manifest shipment"
      actions={(
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button busy={busy} disabled={!complete} onClick={async () => { try { onDone(await run()); } catch { /* the error alert in this dialog shows it; the dialog stays open */ } }}>
            {busy ? 'Creating shipment…' : 'Confirm & manifest'}
          </Button>
        </>
      )}
    >
      <p className="fw-dialog__lead">
        This creates the shipment with the carrier and returns a real AWB. Enter the parcel as it is actually packed.
      </p>

      <div className="fw-form">
        <label className="form-field fw-form__weight">
          <span>Packed weight (g)</span>
          <input type="number" min="1" value={form.weightGrams} onChange={set('weightGrams')} autoFocus />
          {pkg.calculatedItemWeightGrams != null && (
            <small className="fw-form__hint">
              Items total {pkg.calculatedItemWeightGrams} g
              {pkg.calculatedWeightComplete ? '' : ' — some SKUs have no weight recorded'}
            </small>
          )}
        </label>
        <div className="fw-form__dims">
          {[['lengthCm', 'Length', '30'], ['widthCm', 'Width', '25'], ['heightCm', 'Height', '5']].map(([k, label, hint]) => (
            <label key={k} className="form-field">
              <span>{label} (cm)</span>
              <input type="number" min="0.1" step="0.1" inputMode="decimal" placeholder={hint} value={form[k]} onChange={set(k)} />
            </label>
          ))}
        </div>
      </div>

      {/* Read-only, by design. The customer bought this service; the warehouse
          does not get to change what was sold. */}
      <dl className="fw-readonly">
        <div>
          <dt>Shipping mode</dt>
          <dd><strong>{mode}</strong><small>Selected by the customer at checkout</small></dd>
        </div>
        <div>
          <dt>Ship from</dt>
          <dd>{warehouse ? `${warehouse.name} · ${warehouse.postalCode || '—'}` : '—'}<small>Allocated warehouse</small></dd>
        </div>
        <div>
          <dt>Ship to</dt>
          <dd>
            {[order.shippingAddress?.city, order.shippingAddress?.state].filter(Boolean).join(', ') || '—'}
            {' · '}{order.shippingAddress?.postalCode || order.shippingAddress?.postal_code || '—'}
            <small>Destination PIN</small>
          </dd>
        </div>
        <div>
          <dt>Payment</dt>
          <dd>
            {order.paymentMode === 'PREPAID' ? 'Prepaid' : 'COD'}
            {order.codDueMinor > 0 ? ` · collect ${money(order.codDueMinor)}` : ''}
          </dd>
        </div>
      </dl>

      {error && <InlineAlert tone="error">{error.message}</InlineAlert>}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Ready for pickup — a compact confirmation, because it calls the carrier.
// ---------------------------------------------------------------------------
function PickupDialog({ open, onClose, shipment, warehouse, onDone }) {
  const [pickupDate, setPickupDate] = useState(todayLocal());
  const [pickupTime, setPickupTime] = useState('14:00');
  const [printed, setPrinted] = useState(false);
  const [run, { busy, error }] = useMutation(() => adminApi.orders.requestShipmentPickup(shipment.id, {
    pickupDate, pickupTime: `${pickupTime}:00`, labelPrinted: printed,
  }));
  const contact = warehouse?.pickupContact;

  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title="Ready for pickup"
      actions={(
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button busy={busy} disabled={!printed || !pickupDate || !contact?.ready}
            onClick={async () => { try { onDone(await run()); } catch { /* the error alert in this dialog shows it; the dialog stays open */ } }}>
            {busy ? 'Requesting pickup…' : 'Confirm ready for pickup'}
          </Button>
        </>
      )}
    >
      <p className="fw-dialog__lead">
        This tells the delivery partner the parcel is packed and asks them to collect it from the allocated warehouse.
      </p>

      {contact && !contact.ready && (
        <InlineAlert tone="error">
          {contact.message || 'This warehouse has no valid pickup contact number.'} Add one in Warehouses first —
          the pickup agent has no way to reach the warehouse without it.
        </InlineAlert>
      )}

      <div className="fw-form fw-form--pickup">
        <label className="form-field">
          <span>Pickup date</span>
          <input type="date" value={pickupDate} min={todayLocal()} onChange={(e) => setPickupDate(e.target.value)} />
        </label>
        <label className="form-field">
          <span>Pickup time</span>
          <input type="time" value={pickupTime} onChange={(e) => setPickupTime(e.target.value)} />
        </label>
      </div>

      {warehouse && (
        <dl className="fw-readonly">
          <div>
            <dt>Pickup from</dt>
            <dd>
              {warehouse.name}
              <small>
                {[warehouse.addressLine1, warehouse.city, warehouse.postalCode].filter(Boolean).join(', ') || 'Address not set'}
              </small>
            </dd>
          </div>
          <div>
            <dt>Pickup contact</dt>
            <dd>
              {contact?.phone ? `${contact.name || 'Warehouse'} · ${contact.phone}` : 'Not set'}
              <small>The agent calls this number</small>
            </dd>
          </div>
        </dl>
      )}

      <label className="fw-check">
        <input type="checkbox" checked={printed} onChange={(e) => setPrinted(e.target.checked)} />
        <span>The shipping label is printed and attached to the parcel.</span>
      </label>

      {error && <InlineAlert tone="error">{error.message}</InlineAlert>}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
export function FulfillmentWorkspace({
  order, shipments, warehouses, invoiceDocId, canManage, canBook, onChanged,
}) {
  const [dialog, setDialog] = useState(null);
  const [result, setResult] = useState(null);
  const next = order.nextOperatorAction || { action: null, stage: '—', hint: '' };
  const shipment = next.shipmentId
    ? shipments.find((s) => s.id === next.shipmentId)
    : shipments.find((s) => !['CANCELLED', 'FAILED', 'LOST'].includes(s.status)) || null;
  const warehouse = (warehouses || []).find((w) => w.id === shipment?.warehouseId) || (warehouses || [])[0] || null;

  const [confirmOrder, confirmState] = useMutation(() => adminApi.orders.confirm(order.id, order.allocationFingerprint));
  const [startPreparing, prepState] = useMutation(() => adminApi.orders.startProcessing(order.id));
  const [fetchLabel, labelState] = useMutation((shipmentId) => adminApi.orders.fetchShipmentLabel(shipmentId));

  const finish = (message) => { setResult(message); setDialog(null); onChanged(); };

  // run() both sets the error state and rethrows, so the call is guarded and
  // the reload only happens when the carrier actually returned a new link.
  const refreshLabel = async () => {
    if (!shipment?.id) return;
    if (await succeeded(fetchLabel(shipment.id))) { setResult('A fresh label link was fetched from the carrier.'); onChanged(); }
  };

  const allowed = next.action === 'CONFIRM_ORDER' || next.action === 'START_PREPARING' ? canManage : canBook;
  const busy = confirmState.busy || prepState.busy;
  const actionError = confirmState.error || prepState.error || labelState.error;

  const onPrimary = async () => {
    if (next.action === 'CONFIRM_ORDER') { await confirmOrder(); finish('Order confirmed.'); return; }
    if (next.action === 'START_PREPARING') { await startPreparing(); finish('Order moved to preparing.'); return; }
    setDialog(next.action);
  };

  // Progressive disclosure: shipment facts appear only once they exist, and
  // never disappear again.
  const hasShipment = Boolean(shipment && shipment.bookingStatus === 'BOOKED');
  const labelReady = shipment?.labelStatus === 'AVAILABLE';

  return (
    <section id="section-fulfilment" className="fw">
      <header className="fw__head">
        <div>
          <p className="fw__eyebrow">Fulfilment</p>
          <h2 className="fw__stage">{next.stage}</h2>
          <p className="fw__hint">{next.waitingOn ? WAITING_COPY[next.waitingOn] || next.hint : next.hint}</p>
        </div>
        {next.action && allowed && (
          <Button className="fw__primary" busy={busy} onClick={onPrimary}>
            <span aria-hidden="true" className="fw__primary-icon">{ACTION_ICON[next.action]}</span>
            {next.label}
          </Button>
        )}
      </header>

      <ProgressRail progress={order.progress} />

      {result && <InlineAlert tone="success">{result}</InlineAlert>}
      {actionError && <InlineAlert tone="error">{actionError.message}</InlineAlert>}

      {warehouse?.pickupContact && !warehouse.pickupContact.ready && next.action && (
        <InlineAlert tone="warning">
          {warehouse.name} has no usable pickup contact number. Carrier pickup will be refused until one is added in Warehouses.
        </InlineAlert>
      )}

      <div className="fw__facts">
        <div className="fw-fact">
          <span className="fw-fact__label">Warehouse</span>
          <span className="fw-fact__value">{warehouse?.name || '—'}</span>
          <span className="fw-fact__sub">
            {warehouse ? [warehouse.city, warehouse.postalCode].filter(Boolean).join(' · ') : 'Not allocated'}
          </span>
        </div>
        <div className="fw-fact">
          <span className="fw-fact__label">Destination</span>
          <span className="fw-fact__value">
            {order.shippingAddress?.postalCode || order.shippingAddress?.postal_code || '—'}
          </span>
          <span className="fw-fact__sub">
            {[order.shippingAddress?.city, order.shippingAddress?.state].filter(Boolean).join(', ') || '—'}
          </span>
        </div>
        <div className="fw-fact">
          <span className="fw-fact__label">Shipping mode</span>
          <span className="fw-fact__value">{MODE_LABEL[order.shippingMethod] || order.shippingMethod || '—'}</span>
          <span className="fw-fact__sub">Chosen at checkout</span>
        </div>
        <div className="fw-fact">
          <span className="fw-fact__label">Customer sees</span>
          <span className="fw-fact__value">{order.customerStatusLabel || '—'}</span>
          <span className="fw-fact__sub">Internal steps stay internal</span>
        </div>
      </div>

      {hasShipment && (
        <div className="fw__shipment">
          <div className="fw-awb">
            <span className="fw-awb__label">AWB</span>
            <span className="fw-awb__value">{shipment.awbNumber || '—'}</span>
            {shipment.awbNumber && (
              <button type="button" className="fw-awb__copy"
                onClick={() => navigator.clipboard?.writeText(shipment.awbNumber)}>Copy</button>
            )}
            {shipment.trackingUrl && (
              <a className="fw-awb__track" href={shipment.trackingUrl} target="_blank" rel="noreferrer">Track</a>
            )}
          </div>
          <dl className="fw-meta">
            <div><dt>Carrier</dt><dd>{shipment.providerCode || '—'}</dd></div>
            <div><dt>Weight</dt><dd>{shipment.package?.weightGrams ? `${shipment.package.weightGrams} g` : '—'}</dd></div>
            <div>
              <dt>Box</dt>
              <dd>
                {shipment.package?.lengthMm
                  ? `${mmToCm(shipment.package.lengthMm)}×${mmToCm(shipment.package.widthMm)}×${mmToCm(shipment.package.heightMm)} cm`
                  : '—'}
              </dd>
            </div>
            <div><dt>Pickup</dt><dd>{shipment.pickupRequestedAt ? 'Requested' : labelReady ? 'Not yet requested' : '—'}</dd></div>
            {/* Two different numbers, never conflated: what the customer paid
                for shipping, and what the carrier costs CORCOTTON. */}
            <div><dt>Customer paid</dt><dd>{money(order.customerShippingChargeMinor)}</dd></div>
            <div>
              <dt>Carrier cost</dt>
              <dd>{shipment.actualLogisticsCostMinor != null ? money(shipment.actualLogisticsCostMinor) : money(order.actualLogisticsCostMinor)}</dd>
            </div>
          </dl>
        </div>
      )}

      <div className="fw__docs">
        <span className="fw__docs-label">Documents</span>
        {invoiceDocId
          ? <a className="btn btn--secondary" href={adminApi.documents.downloadUrl(invoiceDocId)} target="_blank" rel="noreferrer">Download invoice</a>
          : <span className="text-faint">Invoice not issued yet</span>}
        {labelReady && shipment?.labelUrl && (
          <>
            <a className="btn btn--secondary" href={shipment.labelUrl} target="_blank" rel="noreferrer">Download shipping label</a>
            {/* The carrier hands us a signed link that stops working after a
                day, and the label is most often reprinted long after booking.
                Once a label existed, nothing in the workflow led back to the
                carrier, so a dead link left the warehouse with no route to the
                PDF at all — this asks for a new one. */}
            <Button variant="secondary" busy={labelState.busy} onClick={refreshLabel}>Get a fresh link</Button>
          </>
        )}
        {hasShipment && !labelReady && <span className="text-faint">Label not available yet</span>}
        <span className="fw__docs-note">The customer receives the invoice only — never the shipping label.</span>
      </div>

      {hasShipment && (
        <ShippingLabelPreview order={order} shipment={shipment} warehouse={warehouse} />
      )}

      {dialog === 'MANIFEST_SHIPMENT' && shipment && (
        <ManifestDialog
          open onClose={() => setDialog(null)} order={order} shipment={shipment} warehouse={warehouse}
          onDone={(r) => finish(r?.awbNumber
            ? `Shipment created. AWB ${r.awbNumber}.${r.labelError ? ' The label could not be fetched — retry it from the shipment.' : ''}`
            : 'Shipment created.')}
        />
      )}
      {dialog === 'READY_FOR_PICKUP' && shipment && (
        <PickupDialog
          open onClose={() => setDialog(null)} shipment={shipment} warehouse={warehouse}
          onDone={(r) => finish(
            r?.mode === 'AUTO' ? 'Marked ready. This warehouse is on carrier auto-pickup, so no request was sent.'
              : r?.mode === 'MANUAL_PANEL' ? 'Marked ready. Raise the pickup in the carrier panel.'
                : r?.joinedExisting ? 'Added to the pickup already booked for this warehouse today.'
                  : 'Pickup requested with the carrier.',
          )}
        />
      )}
    </section>
  );
}

export default FulfillmentWorkspace;
