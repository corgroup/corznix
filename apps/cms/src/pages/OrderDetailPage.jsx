import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PageShell } from '../layout/PageShell.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Badge } from '../components/ui/Badge.jsx';
import { Dialog } from '../components/ui/Dialog.jsx';
import { InlineAlert } from '../components/feedback/InlineAlert.jsx';
import { LoadingState } from '../components/feedback/LoadingState.jsx';
import { ErrorState } from '../components/feedback/ErrorState.jsx';
import { adminApi } from '../api/adminApi.js';
import { useApiResource } from '../hooks/useApiResource.js';
import { useMutation } from '../features/catalog/useMutation.js';
import { useAuth } from '../auth/useAuth.js';
import { formatMoney, formatDateTime, formatRelative } from '../utils/format.js';
import { FulfillmentWorkspace } from '../features/fulfillment/FulfillmentWorkspace.jsx';
import './OrderDetailPage.css';

const money = (m) => formatMoney(m);

const STATUS_TONE = { PLACED: 'warn', CONFIRMED: 'good', PROCESSING: 'good', COMPLETED: 'good', CANCELLED: 'muted' };
// A blocked fulfilment must say what a warehouse operator can DO about it.
// "BLOCKED · invalid order state" is a database enum, not an instruction.
const BLOCK_REASON = {
  MISSING_TAX_PROFILE: 'A product on this order has no tax profile — an invoice cannot be issued.',
  TAX_PROFILE_MISSING: 'A product on this order has no tax profile — an invoice cannot be issued.',
  MISSING_SHIPPING_METADATA: 'A SKU on this order has no weight or dimensions recorded.',
  INVALID_ORDER_STATE: 'The order is not yet in a state a carrier booking can be made from.',
};
const PAY_MODE = { PREPAID: 'Prepaid', FULL_COD: 'Full COD', PARTIAL_COD: 'Partial COD' };
const PAY_STATUS = { PAID: 'Paid', PARTIALLY_PAID: 'Partially paid', COD_DUE: 'COD due' };
// Warehouse language, and honest about the middle states: a refund the gateway
// has accepted but not yet paid is not "refunded".
const REFUND_STATUS = {
  SUCCEEDED: 'Refunded', PROCESSING: 'With the gateway', PENDING: 'Starting',
  FAILED: 'Failed', BLOCKED: 'Cannot refund automatically', UNKNOWN: 'Outcome unknown — check the gateway',
};
const REFUND_TONE = { SUCCEEDED: 'good', PROCESSING: 'warn', PENDING: 'warn', FAILED: 'danger', BLOCKED: 'danger', UNKNOWN: 'danger' };
const RETRYABLE_REFUND = new Set(['FAILED', 'BLOCKED', 'UNKNOWN']);
const RETURN_TYPE = {
  RETURN: 'Return', REPLACEMENT: 'Replacement',
  SAME_STYLE_EXCHANGE: 'Same-style exchange', DIFFERENT_STYLE_EXCHANGE: 'Different-style exchange',
};

// ---------------------------------------------------------------------------
// Documents (invoice / packing slip / label) + print — logic unchanged.
// ---------------------------------------------------------------------------
function DocumentsPanel({ orderId, fulfillments, shipments, canManage }) {
  const docs = useApiResource(() => adminApi.documents.forOrder(orderId));
  const invoice = useApiResource(() => adminApi.documents.invoice(orderId).catch((e) => ({ error: e })));
  const [gen, genState] = useMutation((fn) => fn());
  const [regen, regenState] = useMutation(() => adminApi.documents.regenerateInvoice(orderId));

  const invErr = invoice.data?.error;
  const taxBlock = invErr?.status === 409 ? (invErr.details?.meta || {}) : null;
  const missing = Array.isArray(taxBlock?.missing) ? taxBlock.missing : [];

  return (
    <section id="section-documents" className="od-card">
      <h3 className="od-card__title">Documents</h3>
      {(docs.error || genState.error || regenState.error) && (
        <InlineAlert tone="error">{(docs.error || genState.error || regenState.error).message}</InlineAlert>
      )}

      {taxBlock && (
        <div className="od-taxblock">
          <p className="od-taxblock__head">Invoice blocked — tax configuration is {taxBlock.taxStatus || 'incomplete'}.</p>
          {missing.length > 0 ? (
            <>
              <p className="text-faint">These need a tax profile before an invoice can be issued:</p>
              <ul className="od-taxblock__list">
                {missing.map((m, i) => (
                  <li key={i}>{m.productName || m.name || m.sku || m.productId || String(m)}{m.sku ? ` · ${m.sku}` : ''}</li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-faint">Configure the affected products in Tax Profiles, then regenerate.</p>
          )}
          <div className="od-actions">
            <Link className="btn btn--secondary" to="/tax-profiles">Review tax profiles</Link>
            {canManage && (
              <Button variant="secondary" busy={regenState.busy}
                onClick={async () => { await regen(); docs.reload(); invoice.reload(); }}>Regenerate invoice</Button>
            )}
          </div>
        </div>
      )}

      {canManage && !taxBlock && (
        <div className="od-actions" style={{ marginBottom: 12 }}>
          <Button variant="secondary" busy={regenState.busy}
            onClick={async () => { await regen(); docs.reload(); invoice.reload(); }}>Issue / regenerate invoice</Button>
          {fulfillments.map((f) => f.id && (
            <Button key={f.id} variant="secondary" busy={genState.busy}
              onClick={async () => { await gen(() => adminApi.documents.packingSlip(f.id)); docs.reload(); }}>
              Packing slip · {f.fulfillmentNumber}
            </Button>
          ))}
          {shipments.filter((s) => s.bookingStatus === 'BOOKED').map((s) => (
            <Button key={s.id} variant="secondary" busy={genState.busy}
              onClick={async () => { await gen(() => adminApi.documents.label(s.id)); docs.reload(); }}>
              Label · {s.shipmentNumber}
            </Button>
          ))}
        </div>
      )}

      <p className="text-faint" style={{ marginTop: 0, fontSize: 12 }}>
        Download the invoice and shipping label, then print and attach them to the package manually.
      </p>
      <div className="table-wrap">
        <table className="data-table">
          <thead><tr><th>Type</th><th>Status</th><th>Format</th><th>File</th></tr></thead>
          <tbody>
            {(docs.data?.documents ?? []).map((d) => (
              <tr key={d.id}>
                <td>{d.type}</td>
                <td><Badge tone={d.status === 'READY' ? 'good' : 'muted'}>{d.status}</Badge></td>
                <td>{d.format}</td>
                <td>{d.status === 'READY'
                  ? <a href={adminApi.documents.downloadUrl(d.id)} target="_blank" rel="noreferrer">Download</a>
                  : <span className="text-faint">—</span>}</td>
              </tr>
            ))}
            {(docs.data?.documents ?? []).length === 0 && (
              <tr><td colSpan={4} className="data-table__empty">No documents yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// NDR — logic unchanged.
function NdrPanel({ shipments, canManage, onChange }) {
  const inException = shipments.filter((s) => s.status === 'DELIVERY_EXCEPTION' && s.ndr);
  if (!inException.length) return null;
  return (
    <section className="od-card od-card--alert">
      <h3 className="od-card__title">Delivery exception (NDR)</h3>
      {inException.map((s) => <NdrRow key={s.id} shipment={s} canManage={canManage} onChange={onChange} />)}
    </section>
  );
}

function NdrRow({ shipment, canManage, onChange }) {
  const n = shipment.ndr;
  const [submit, { busy, error }] = useMutation(({ action }) => adminApi.orders.submitShipmentNdrAction(shipment.id, action));
  const [refresh, refreshState] = useMutation((actionId) => adminApi.orders.refreshNdrAction(actionId));
  const act = (a) => async () => { try { await submit({ action: a }); } finally { onChange(); } };
  return (
    <div className="od-ndr">
      <strong>{shipment.shipmentNumber}</strong> · attempt {n.attemptCount}
      {n.latestNslCode ? ` · NSL ${n.latestNslCode}` : ''}
      {n.nslHint ? ` (carrier-eligible: ${n.nslHint === 'RE_ATTEMPT' ? 're-attempt' : 'reschedule'})` : ''}
      {n.latestReason && <div className="text-faint">{n.latestReason}</div>}
      {n.pendingAction && (
        <div>Pending: {n.pendingAction.action} · {n.pendingAction.status}{' '}
          <Button variant="secondary" busy={refreshState.busy} onClick={async () => { await refresh(n.pendingAction.id); onChange(); }}>Refresh</Button>
        </div>
      )}
      {(n.actions || []).filter((a) => !n.pendingAction || a.id !== n.pendingAction.id).map((a) => (
        <div key={a.id} className="text-faint">{a.action}: {a.status}{a.providerRemark ? ` — ${a.providerRemark}` : ''}</div>
      ))}
      {canManage && !n.pendingAction && (
        <div className="od-actions" style={{ marginTop: 6 }}>
          <Button variant="secondary" busy={busy} disabled={!n.canReAttempt} onClick={act('RE_ATTEMPT')}
            title={n.canReAttempt ? 'Ask the carrier to attempt delivery again' : `Re-attempts used: ${n.reattemptsUsed}/${n.maxReattempts}`}>
            Request re-attempt ({n.reattemptsUsed}/{n.maxReattempts})
          </Button>
          <Button variant="secondary" busy={busy} disabled={!n.canReschedule} onClick={act('RESCHEDULE')}>Reschedule</Button>
        </div>
      )}
      {error && <div className="od-err">{error.message}</div>}
    </div>
  );
}

// Carrier documents — logic unchanged.
const CARRIER_DOC_LABELS = { EPOD: 'Proof of delivery', QC_IMAGE: 'QC image', SORTER_IMAGE: 'Sorter / weight image', SIGNATURE: 'Signature' };

function CarrierDocumentsPanel({ shipments, canManage, onChange }) {
  const withDocs = shipments.filter((s) => (s.carrierDocuments || []).length || s.bookingStatus === 'BOOKED');
  if (!withDocs.length) return null;
  return (
    <section className="od-card">
      <h3 className="od-card__title">Carrier documents</h3>
      {withDocs.map((s) => <CarrierDocRow key={s.id} shipment={s} canManage={canManage} onChange={onChange} />)}
    </section>
  );
}

function CarrierDocRow({ shipment, canManage, onChange }) {
  const [fetchDoc, { busy, error }] = useMutation((docType) => adminApi.orders.fetchShipmentCarrierDocument(shipment.id, docType));
  const docs = shipment.carrierDocuments || [];
  const run = (t) => async () => { try { await fetchDoc(t); } finally { onChange(); } };
  return (
    <div className="od-ndr">
      <strong>{shipment.shipmentNumber}</strong>
      {docs.length ? (
        <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
          {docs.map((d) => (
            <li key={d.id} style={{ fontSize: 13 }}>
              {CARRIER_DOC_LABELS[d.docType] || d.docType} · {d.source === 'WEBHOOK' ? 'pushed' : 'pulled'} · {' '}
              {d.imageStatus === 'STORED' && <a href={d.contentPath} target="_blank" rel="noreferrer">view</a>}
              {d.imageStatus === 'LINKED_URL' && <a href={d.url} target="_blank" rel="noreferrer">view (carrier)</a>}
              {d.imageStatus === 'PENDING_FETCH' && 'awaiting image'}
              {d.imageStatus === 'UNAVAILABLE' && 'not available at carrier'}
              {d.linkStatus === 'UNMATCHED_AWB' && <span className="pill pill--warn" style={{ marginLeft: 6 }}>unmatched AWB</span>}
              {d.linkStatus === 'REF_MISMATCH' && <span className="pill pill--warn" style={{ marginLeft: 6 }}>order-ref mismatch</span>}
            </li>
          ))}
        </ul>
      ) : <span className="text-faint"> — none received</span>}
      {canManage && shipment.bookingStatus === 'BOOKED' && (
        <div className="od-actions" style={{ marginTop: 4 }}>
          {['EPOD', 'QC_IMAGE', 'SIGNATURE'].map((t) => (
            <Button key={t} variant="secondary" busy={busy} onClick={run(t)}>Fetch {CARRIER_DOC_LABELS[t].toLowerCase()}</Button>
          ))}
        </div>
      )}
      {error && <div className="od-err">{error.message}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// New sections
// ---------------------------------------------------------------------------
function ItemsSection({ items, order, canCatalog }) {
  const subtotal = order.subtotalMinor;
  const discount = order.discountMinor || 0;
  const shipping = order.shippingMinor || 0;
  const totalUnits = items.reduce((n, i) => n + i.quantity, 0);
  return (
    <section id="section-items" className="od-card">
      <h3 className="od-card__title">Items <span className="text-faint">· {totalUnits} unit{totalUnits === 1 ? '' : 's'}</span></h3>
      <div className="table-wrap">
        <table className="data-table od-items">
          <thead>
            <tr><th>Product</th><th>SKU</th><th>Qty</th><th>Unit price</th><th>Line total</th><th>Allocation</th></tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id}>
                <td>
                  <div className="od-item">
                    {it.imageUrl
                      ? <img src={it.imageUrl} alt="" loading="lazy" />
                      : <span className="od-item__ph" aria-hidden="true">◫</span>}
                    <div>
                      {canCatalog && it.productSlug
                        ? <Link to={`/products/${it.productId}`}>{it.productName}</Link>
                        : <span>{it.productName}</span>}
                      <div className="data-table__sub">
                        {[it.color, it.size].filter(Boolean).join(' / ') || '—'}
                        {!it.productLive && <span className="pill pill--warn" style={{ marginLeft: 6 }}>product archived</span>}
                      </div>
                    </div>
                  </div>
                </td>
                <td><code>{it.sku}</code></td>
                <td>{it.quantity}</td>
                <td>{money(it.unitPriceMinor)}</td>
                <td>{money(it.lineTotalMinor)}</td>
                <td className="text-faint">
                  {it.allocation
                    ? `${it.allocation.fulfillmentNumber} · ${it.allocation.readinessStatus || it.allocation.status}`
                    : 'Not allocated'}
                </td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={6} className="data-table__empty">No items on this order.</td></tr>}
          </tbody>
        </table>
      </div>

      <dl className="od-totals">
        <div><dt>Subtotal</dt><dd>{money(subtotal)}</dd></div>
        {discount > 0 && (
          <div><dt>Discount{order.discounts?.[0]?.couponCode ? ` · ${order.discounts[0].couponCode}` : ''}</dt><dd>−{money(discount)}</dd></div>
        )}
        <div>
          <dt>Shipping{order.ownerDelivery ? ' · Owner Delivery' : order.shippingMethod ? ` · ${order.shippingMethod === 'STANDARD' ? 'Surface' : order.shippingMethod === 'EXPRESS' ? 'Express' : order.shippingMethod}` : ''}</dt>
          <dd>{shipping > 0 ? money(shipping) : 'Free'}</dd>
        </div>
        <div className="od-totals__grand"><dt>Total</dt><dd>{money(order.totalMinor)}</dd></div>
        <div className="od-totals__note"><dt>Tax</dt><dd className="text-faint">GST included in prices · broken out on the invoice</dd></div>
      </dl>
    </section>
  );
}

function AllocationSection({ order, fulfillments, shipments }) {
  void shipments;
  return (
    <section id="section-fulfilment" className="od-card">
      <h3 className="od-card__title">Allocation &amp; fulfilment</h3>
      {order.ownerDelivery && (
        <InlineAlert tone="warning">
          <strong>Owner Delivery{order.ownerDeliveryZone ? ` — ${order.ownerDeliveryZone}` : ''}.</strong>{' '}
          The store delivers this order itself. Do not book a carrier — carrier booking is disabled for this order.
        </InlineAlert>
      )}
      {fulfillments.length === 0 ? (
        <div className="od-empty">
          <p>No allocation yet.</p>
          <p className="text-faint">
            {order.status === 'PLACED'
              ? 'Confirm the order to allocate items to a warehouse and build fulfilments.'
              : 'Fulfilments appear once the order is confirmed.'}
          </p>
        </div>
      ) : (
        <>
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Fulfilment</th><th>Status</th><th>Readiness</th><th>Units</th></tr></thead>
              <tbody>
                {fulfillments.map((f) => (
                  <tr key={f.fulfillmentNumber}>
                    <td>{f.fulfillmentNumber}</td>
                    <td><Badge tone={f.status === 'FULFILLED' ? 'good' : f.status === 'CANCELLED' ? 'muted' : 'warn'}>{f.status}</Badge></td>
                    <td className={f.readinessStatus === 'READY' ? '' : 'text-faint'}>
                      {f.readinessStatus === 'READY' ? 'Ready to book' : 'Not ready to book'}
                      {f.blockReason && <div className="data-table__sub">{BLOCK_REASON[f.blockReason] || String(f.blockReason).replace(/_/g, ' ').toLowerCase()}</div>}
                    </td>
                    <td>{(f.items || []).reduce((s, i) => s + (i.quantity || 0), 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function ShipmentsSection({ shipments, canBook, actions, running }) {
  return (
    <section id="section-shipments" className="od-card">
      <h3 className="od-card__title">Shipments</h3>
      {shipments.length === 0 ? (
        <div className="od-empty">
          <p>No shipments yet.</p>
          <p className="text-faint">A draft shipment is created per fulfilment once the order is confirmed. Start processing, then book it with the carrier.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr><th>Shipment</th><th>Status</th><th>Booking</th><th>AWB</th><th>Label</th><th>Provider</th><th>COD</th>{canBook && <th>Next action</th>}</tr>
            </thead>
            <tbody>
              {shipments.map((s) => {
                const acts = s.nextActions || [];
                return (
                  <tr key={s.id}>
                    <td>{s.shipmentNumber}</td>
                    <td>{String(s.status).replace(/_/g, ' ').toLowerCase()}</td>
                    <td><Badge tone={s.bookingStatus === 'BOOKED' ? 'good' : ['FAILED', 'UNKNOWN'].includes(s.bookingStatus) ? 'warn' : 'muted'}>{s.bookingStatus}</Badge></td>
                    <td>{s.awbNumber
                      ? (s.trackingUrl ? <a href={s.trackingUrl} target="_blank" rel="noreferrer">{s.awbNumber}</a> : s.awbNumber)
                      : <span className="text-faint">—</span>}</td>
                    <td>
                      {s.labelStatus === 'AVAILABLE'
                        ? <>{s.labelUrl ? <a href={s.labelUrl} target="_blank" rel="noreferrer">PDF</a> : 'ready'}{s.labelPrintedAt ? ' · printed' : ''}</>
                        : s.labelStatus === 'FAILED' ? <span className="pill pill--warn">failed</span>
                          : s.labelStatus === 'PENDING' ? 'fetching…' : <span className="text-faint">—</span>}
                    </td>
                    <td className="text-faint">
                      {s.lastProviderStatus || '—'}{s.pickupRequestedAt ? ' · pickup requested' : ''}
                      {s.automation && !['IDLE', 'DONE'].includes(s.automation.status) && (
                        <div className={s.automation.status === 'BLOCKED' || s.automation.status === 'FAILED' ? 'od-err' : ''}>
                          auto: {s.automation.status}{s.automation.step ? ` @ ${s.automation.step}` : ''}{s.automation.error ? ` — ${s.automation.error}` : ''}
                        </div>
                      )}
                    </td>
                    <td>{s.codCollectionMinor > 0 ? money(s.codCollectionMinor) : <span className="text-faint">—</span>}</td>
                    {canBook && (
                      <td className="od-shipment-actions">
                        {s.bookingStatus === 'UNKNOWN' && <span className="pill pill--warn">Reconcile needed</span>}
                        {acts.includes('RECONCILE') && (
                          <Button variant="secondary" busy={running.reconcile} onClick={() => actions.reconcile(s.id)}>
                            {s.bookingStatus === 'UNKNOWN' ? 'Reconcile booking' : 'Refresh tracking'}
                          </Button>
                        )}
                        {(acts.includes('FETCH_LABEL') || acts.includes('RETRY_LABEL')) && (
                          <Button variant="secondary" busy={running.label} onClick={() => actions.fetchLabel(s.id)}>
                            {acts.includes('RETRY_LABEL') ? 'Retry label' : 'Fetch label'}
                          </Button>
                        )}
                        {acts.includes('CANCEL_SHIPMENT') && (
                          <Button variant="danger" busy={running.cancelShip} onClick={() => actions.cancelShip(s.id)}>Cancel shipment</Button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---- right rail --------------------------------------------------------
function TimelineCard({ orderId }) {
  const { status, data } = useApiResource(() => adminApi.orders.timeline(orderId));
  const events = data?.events || [];
  return (
    <div className="rail-card">
      <h3 className="rail-card__title">Timeline</h3>
      {status === 'loading' && <p className="text-faint">Loading…</p>}
      {status === 'ready' && events.length === 0 && <p className="text-faint">No events recorded.</p>}
      <ol className="od-timeline">
        {events.slice().reverse().map((e, i) => (
          <li key={i} className={`od-timeline__item od-timeline__item--${e.category.toLowerCase()}`}>
            <span className="od-timeline__dot" aria-hidden="true" />
            <div>
              <p className="od-timeline__title">{e.title}</p>
              {e.detail && <p className="od-timeline__detail">{e.detail}</p>}
              <p className="od-timeline__meta">{formatRelative(e.at)}{e.actor ? ` · ${e.actor}` : ''}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ReturnsCard({ orderId }) {
  const { data } = useApiResource(() => adminApi.orders.linkedReturns(orderId));
  const returns = data?.returns || [];
  if (returns.length === 0) return null;
  return (
    <div className="rail-card">
      <h3 className="rail-card__title">Returns &amp; exchanges</h3>
      <ul className="od-returns">
        {returns.map((r) => (
          <li key={r.id}>
            <Link to={`/returns/${r.id}`}>{r.requestNumber}</Link>
            <span className="data-table__sub">
              {RETURN_TYPE[r.requestType] || r.requestType} · {String(r.status).replace(/_/g, ' ').toLowerCase()}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AddressBlock({ addr }) {
  if (!addr) return <p className="text-faint">—</p>;
  const a1 = addr.addressLine1 || addr.address_line1;
  const a2 = addr.addressLine2 || addr.address_line2;
  const pin = addr.postalCode || addr.postal_code;
  return (
    <p className="od-address">
      {[addr.firstName, addr.lastName].filter(Boolean).join(' ')}<br />
      {a1}{a2 ? <>, {a2}</> : null}<br />
      {[addr.city, addr.state, pin].filter(Boolean).join(', ')}<br />
      {addr.country || ''}{addr.phone ? <><br />{addr.phone}</> : null}
    </p>
  );
}

// ---------------------------------------------------------------------------
export function OrderDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('orders.manage');
  const canBook = hasPermission('fulfillment.manage');
  const canCatalog = hasPermission('catalog.read');
  const { status, data, error, reload } = useApiResource(() => adminApi.orders.get(id));
  // Surfaced once, at the top of the workspace, instead of being found by
  // scanning a table of every file the order has ever produced.
  const orderDocs = useApiResource(() => adminApi.documents.forOrder(id));
  const invoiceDocId = (orderDocs.data?.documents ?? [])
    .find((d) => d.type === 'INVOICE' && d.status === 'READY')?.id ?? null;

  const [cancel, cancelState] = useMutation((reason) => adminApi.orders.cancel(id, reason));
  const [fetchLabel, labelState] = useMutation((sid) => adminApi.orders.fetchShipmentLabel(sid));
  const [cancelShip, cancelShipState] = useMutation(({ shipmentId, reason }) => adminApi.orders.cancelShipmentAtProvider(shipmentId, reason));
  const [reconcile, reconcileState] = useMutation((sid) => adminApi.orders.reconcileShipment(sid));
  const [retryRefund, refundState] = useMutation(() => adminApi.orders.retryCancellationRefund(id));

  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  const run = (fn) => async (...a) => { try { await fn(...a); } finally { reload(); } };
  const shipActions = {
    reconcile: run(reconcile), fetchLabel: run(fetchLabel),
    cancelShip: (sid) => {
      const reason = window.prompt('Reason for cancelling this shipment with the carrier (optional):') || undefined;
      return run(cancelShip)({ shipmentId: sid, reason });
    },
  };
  const running = {
    reconcile: reconcileState.busy, label: labelState.busy, cancelShip: cancelShipState.busy, refund: refundState.busy,
  };
  const actions = { retryRefund: run(retryRefund) };

  if (status === 'loading') return <PageShell title="Order"><LoadingState label="Loading order…" /></PageShell>;
  if (status === 'error') {
    return (
      <PageShell title="Order">
        <ErrorState message={error?.message} onRetry={reload} />
        <Link to="/orders" className="btn btn--secondary">Back to orders</Link>
      </PageShell>
    );
  }

  const { order, items = [], fulfillments = [], shipments = [], warehouses = [] } = data;
  const actionError = cancelState.error;
  const totalUnits = items.reduce((n, i) => n + i.quantity, 0);
  const shipmentStatus = shipments.length === 0 ? 'Not booked'
    : shipments.every((s) => s.bookingStatus === 'BOOKED') ? 'Booked'
      : shipments.some((s) => s.bookingStatus === 'BOOKED') ? 'Partly booked' : 'Not booked';

  return (
    <div className="order-detail">
      <div className="od-bar">
        <div className="od-bar__id">
          <button type="button" className="od-bar__back" onClick={() => navigate('/orders')} aria-label="Back to orders">←</button>
          <div>
            <p className="od-bar__crumb"><Link to="/orders">Orders</Link><span aria-hidden="true"> › </span>{order.orderNumber}</p>
            <h1 className="od-bar__title">{order.orderNumber}</h1>
            <p className="od-bar__sub">
              <Badge tone={STATUS_TONE[order.status]}>{order.status}</Badge>
              <Badge tone="muted">{PAY_MODE[order.paymentMode] || order.paymentMode}</Badge>
              <Badge tone={order.paymentStatus === 'PAID' ? 'good' : 'warn'}>{PAY_STATUS[order.paymentStatus] || order.paymentStatus}</Badge>
              {order.codDueMinor > 0 && <span className="od-bar__cod">COD due {money(order.codDueMinor)}</span>}
              <span className="text-faint">· placed {formatDateTime(order.placedAt)}</span>
            </p>
          </div>
        </div>
        {/* The primary fulfilment action lives in ONE place — the workspace
            below. Only the exception action stays up here, and it is
            deliberately quiet. */}
        <div className="od-bar__actions">
          {canManage && ['PLACED', 'CONFIRMED', 'PROCESSING'].includes(order.status) && (
            <Button variant="danger" onClick={() => { setCancelReason(''); setCancelOpen(true); }}>Cancel order</Button>
          )}
        </div>
      </div>

      {actionError && <InlineAlert tone="error">{actionError.message}</InlineAlert>}

      <div className="od-kpis">
        <div className="od-kpi"><span className="od-kpi__value">{money(order.totalMinor)}</span><span className="od-kpi__label">Order total</span></div>
        <div className="od-kpi"><span className="od-kpi__value">{money(order.onlinePaidMinor)}</span><span className="od-kpi__label">Paid amount</span></div>
        <div className="od-kpi"><span className={`od-kpi__value${order.codDueMinor > 0 ? ' od-kpi__value--warn' : ''}`}>{money(order.codDueMinor)}</span><span className="od-kpi__label">COD due</span></div>
        <div className="od-kpi"><span className="od-kpi__value">{totalUnits}</span><span className="od-kpi__label">Item{totalUnits === 1 ? '' : 's'}</span></div>
        <div className="od-kpi"><span className="od-kpi__value od-kpi__value--sm">{shipmentStatus}</span><span className="od-kpi__label">Shipment</span></div>
      </div>

      <div className="od-grid">
        <div className="od-grid__main">
          <FulfillmentWorkspace
            order={order}
            shipments={shipments}
            warehouses={warehouses}
            invoiceDocId={invoiceDocId}
            canManage={canManage}
            canBook={canBook}
            onChanged={reload}
          />
          <ItemsSection items={items} order={order} canCatalog={canCatalog} />
          {/* Exceptions only — an NDR is not part of the normal flow. */}
          <NdrPanel shipments={shipments} canManage={canBook} onChange={reload} />
          <AllocationSection order={order} fulfillments={fulfillments} shipments={shipments} />
          {/* Everything below is reference material, folded away by default so
              it cannot compete with the one next action. */}
          <details className="od-advanced">
            <summary>Shipment details, carrier documents &amp; all files</summary>
            <div className="od-advanced__body">
              <ShipmentsSection shipments={shipments} canBook={canBook} actions={shipActions} running={running} />
              <CarrierDocumentsPanel shipments={shipments} canManage={canBook} onChange={reload} />
              <DocumentsPanel orderId={id} fulfillments={fulfillments} shipments={shipments} canManage={canBook} />
            </div>
          </details>
        </div>

        <aside className="od-grid__rail">
          <div className="rail-card">
            <h3 className="rail-card__title">Order record</h3>
            <dl className="rail-facts">
              <div><dt>Customer sees</dt><dd>{order.customerStatusLabel || '—'}</dd></div>
              {order.confirmedAt && <div><dt>Confirmed</dt><dd>{formatRelative(order.confirmedAt)}</dd></div>}
              {order.processingStartedAt && <div><dt>Processing</dt><dd>{formatRelative(order.processingStartedAt)}</dd></div>}
              {order.completedAt && <div><dt>Completed</dt><dd>{formatRelative(order.completedAt)}</dd></div>}
              {order.cancelledAt && <div><dt>Cancelled</dt><dd>{formatRelative(order.cancelledAt)}</dd></div>}
            </dl>
          </div>

          <div id="section-customer" className="rail-card">
            <h3 className="rail-card__title">Customer</h3>
            {order.customer ? (
              <>
                <p className="od-address">
                  {order.customer.name || '—'}<br />
                  {order.customer.email || '—'}<br />
                  {order.customer.phone || '—'}
                </p>
                {canManage && order.customer.id && (
                  <Link className="linkish" to={`/customers/${order.customer.id}`}>Open customer</Link>
                )}
              </>
            ) : <p className="text-faint">—</p>}
          </div>

          <div className="rail-card">
            <h3 className="rail-card__title">Shipping address</h3>
            <AddressBlock addr={order.shippingAddress} />
            <h4 className="rail-card__subtitle">Billing address</h4>
            <p className="text-faint">{order.billingSameAsShipping ? 'Same as shipping' : '—'}</p>
          </div>

          <div className="rail-card">
            <h3 className="rail-card__title">Payment</h3>
            <dl className="rail-facts">
              <div><dt>Method</dt><dd>{PAY_MODE[order.paymentMode] || order.paymentMode}</dd></div>
              <div><dt>Status</dt><dd>{PAY_STATUS[order.paymentStatus] || order.paymentStatus}</dd></div>
              <div><dt>Order amount</dt><dd>{money(order.totalMinor)}</dd></div>
              <div><dt>Paid</dt><dd>{money(order.onlinePaidMinor)}</dd></div>
              <div><dt>COD due</dt><dd>{money(order.codDueMinor)}</dd></div>
            </dl>
            {/* A cancelled order used to say only CANCELLED, while the refund
                behind it could be pending, failed or blocked with nothing but a
                staff task to say so. */}
            {data.cancellationRefund && (
              <>
                <h4 className="rail-card__subtitle">Refund to the original payment</h4>
                <dl className="rail-facts">
                  <div><dt>Status</dt><dd><Badge tone={REFUND_TONE[data.cancellationRefund.status] || 'warn'}>{REFUND_STATUS[data.cancellationRefund.status] || data.cancellationRefund.status}</Badge></dd></div>
                  <div><dt>Amount</dt><dd>{money(data.cancellationRefund.amountMinor)}</dd></div>
                  <div><dt>Reference</dt><dd>{data.cancellationRefund.providerRefundId || '—'}</dd></div>
                  {data.cancellationRefund.failureCode && (
                    <div><dt>Reason</dt><dd className="text-faint">{data.cancellationRefund.failureCode}</dd></div>
                  )}
                </dl>
                {RETRYABLE_REFUND.has(data.cancellationRefund.status) && (
                  <Button variant="secondary" busy={running.refund} onClick={actions.retryRefund}>Retry refund</Button>
                )}
              </>
            )}
          </div>

          <ReturnsCard orderId={id} />
          <TimelineCard orderId={id} />
        </aside>
      </div>

      <Dialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title={`Cancel order ${order.orderNumber}?`}
        actions={
          <>
            <Button variant="ghost" onClick={() => setCancelOpen(false)}>Keep order</Button>
            <Button
              variant="danger-solid"
              busy={cancelState.busy}
              onClick={async () => {
                try { await cancel(cancelReason.trim() || undefined); setCancelOpen(false); } finally { reload(); }
              }}
            >
              Cancel order
            </Button>
          </>
        }
      >
        <p>Current status: <strong>{order.status}</strong>.</p>
        <p>This runs the full cancellation cascade:</p>
        <ul>
          <li>Order status → <strong>CANCELLED</strong></li>
          <li>Reserved / allocated inventory is restored</li>
          <li>Open fulfilments and shipments are cancelled{shipments.some((s) => s.bookingStatus === 'BOOKED') ? ' (a booked AWB is voided with the carrier)' : ''}</li>
          <li>A credit note is issued if an invoice exists</li>
          <li>The customer is notified</li>
        </ul>
        <label className="form-field" style={{ marginTop: 8 }}>
          <span>Reason (optional)</span>
          <input value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} placeholder="e.g. customer request" />
        </label>
        {cancelState.error && <InlineAlert tone="error">{cancelState.error.message}</InlineAlert>}
      </Dialog>
    </div>
  );
}

export default OrderDetailPage;
