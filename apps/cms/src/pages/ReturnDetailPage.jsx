import { useParams } from 'react-router-dom';
import { PageShell } from '../layout/PageShell.jsx';
import { Button } from '../components/ui/Button.jsx';
import { InlineAlert } from '../components/feedback/InlineAlert.jsx';
import { LoadingState } from '../components/feedback/LoadingState.jsx';
import { ErrorState } from '../components/feedback/ErrorState.jsx';
import { adminApi } from '../api/adminApi.js';
import { useApiResource } from '../hooks/useApiResource.js';
import { useMutation } from '../features/catalog/useMutation.js';
import { useAuth } from '../auth/useAuth.js';
import { CodPayoutPanel } from '../features/returns/CodPayoutPanel.jsx';

const money = (m) => (m == null ? '—' : `₹${(Number(m) / 100).toFixed(2)}`);
const when = (d) => (d ? new Date(d).toLocaleString() : '—');

export function ReturnDetailPage() {
  const { id } = useParams();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('returns.manage');
  const canRefund = hasPermission('returns.refund');
  const { status, data: r, error, reload } = useApiResource(() => adminApi.returns.get(id));

  const [act, actState] = useMutation((fn) => fn());
  const run = (fn, confirmMsg) => async () => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    try { await act(fn); } finally { reload(); }
  };

  if (status === 'loading') return <PageShell title="Return"><LoadingState label="Loading return…" /></PageShell>;
  if (status === 'error') return <PageShell title="Return"><ErrorState message={error?.message} onRetry={reload} /></PageShell>;

  const rev = r.reverseShipment;
  const isExchangeOut = ['REPLACEMENT', 'SAME_STYLE_EXCHANGE'].includes(r.requestType);

  return (
    <PageShell
      title={r.requestNumber}
      description={`${r.requestType.replaceAll('_', ' ')} · order ${r.order?.orderNumber ?? '—'} · ${r.order?.paymentMode ?? ''}`}
    >
      <p>
        <span className={`pill pill--${r.status === 'COMPLETED' ? 'good' : ['REJECTED', 'CANCELLED'].includes(r.status) ? 'muted' : 'warn'}`}>{r.status.replaceAll('_', ' ')}</span>
        {r.qcResult ? `  ·  QC ${r.qcResult}` : ''}
        {r.reasonCode ? `  ·  ${r.reasonCode}` : ''}
      </p>

      {actState.error && <InlineAlert tone="error">{actState.error.message}</InlineAlert>}

      {canManage && (
        <div className="editor-actions" style={{ marginBottom: 24, flexWrap: 'wrap' }}>
          {r.status === 'REQUESTED' && <Button variant="success" busy={actState.busy} onClick={run(() => adminApi.returns.approve(id))}>Approve</Button>}
          {r.status === 'REQUESTED' && <Button variant="danger" busy={actState.busy} onClick={run(() => adminApi.returns.reject(id), 'Reject this request? The customer will be notified and this cannot be undone.')}>Reject</Button>}
          {r.status === 'APPROVED' && <Button busy={actState.busy} onClick={run(() => adminApi.returns.preparePickup(id))}>Prepare Pickup</Button>}
          {r.status === 'PICKUP_PENDING' && <Button busy={actState.busy} onClick={run(() => adminApi.returns.bookPickup(id))}>Book Pickup</Button>}
          {['PICKUP_BOOKED', 'PICKED_UP', 'IN_TRANSIT', 'MANUAL_RETURN_LOGISTICS_REQUIRED'].includes(r.status) && <Button busy={actState.busy} onClick={run(() => adminApi.returns.markReceived(id))}>Mark Received</Button>}
          {r.status === 'RECEIVED' && <Button variant="success" busy={actState.busy} onClick={run(() => adminApi.returns.qc(id, 'PASS'))}>QC Pass</Button>}
          {r.status === 'RECEIVED' && <Button variant="danger" busy={actState.busy} onClick={run(() => adminApi.returns.qc(id, 'FAIL'), 'Fail QC? No restock and no refund will be issued automatically.')}>QC Fail</Button>}
          {isExchangeOut && r.qcResult === 'PASS' && !r.replacementFulfillment && <Button busy={actState.busy} onClick={run(() => adminApi.returns.releaseReplacement(id))}>Release {r.requestType === 'REPLACEMENT' ? 'Replacement' : 'Exchange Item'}</Button>}
          {r.status === 'RESOLUTION_PENDING' && (
            <Button busy={actState.busy} onClick={run(() => adminApi.returns.complete(id), r.requestType === 'RETURN' ? 'Complete this return? This triggers the refund / credit-note resolution.' : 'Complete this request?')}>Complete</Button>
          )}
          {canRefund && r.refund && ['UNKNOWN', 'FAILED', 'BLOCKED'].includes(r.refund.status) && (
            <Button variant="secondary" busy={actState.busy} onClick={run(() => adminApi.returns.retryRefund(id, r.refund.status === 'UNKNOWN' ? { providerOutcome: 'SUCCEEDED' } : {}), 'Retry the refund resolution for this return?')}>Retry Refund</Button>
          )}
          {rev && rev.status === 'UNKNOWN' && (
            <Button variant="secondary" busy={actState.busy} onClick={run(() => adminApi.returns.reconcileReverse(rev.id ?? id, 'CONFIRMED'), 'Confirm the reverse pickup was created by the carrier?')}>Reconcile Pickup</Button>
          )}
        </div>
      )}
      {!canRefund && r.refund && <InlineAlert tone="info">Refund actions require the returns.refund permission.</InlineAlert>}

      <h3>Items</h3>
      <div className="table-wrap">
        <table className="data-table">
          <thead><tr><th>SKU</th><th>Qty</th><th>Value</th><th>Delivered</th><th>Deadline</th><th>Restocked</th><th>Target</th></tr></thead>
          <tbody>
            {r.items.map((it) => (
              <tr key={it.orderItemId}>
                <td>{it.skuId}</td>
                <td>{it.quantity}</td>
                <td>{money(it.eligibleValueMinor)}</td>
                <td>{when(it.deliveredAt)}</td>
                <td>{when(it.returnDeadline)}</td>
                <td>{it.restockedQuantity > 0 ? `${it.restockedQuantity} → ${it.restockWarehouseId ?? ''}` : '—'}</td>
                <td>{it.target ? it.target.skuId : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>Reverse pickup</h3>
      {rev ? (
        <p>
          {rev.shipmentNumber} · <strong>{rev.status.replaceAll('_', ' ')}</strong>
          {rev.serviceable === false ? ' · not serviceable (manual)' : ''} · to warehouse {rev.destinationWarehouseId}
          <br />{rev.timeline?.map((e) => e.status).join(' → ') || 'No tracking yet'}
        </p>
      ) : <p>Not prepared.</p>}

      {r.qcSnapshot && <QcSnapshotPanel snap={r.qcSnapshot} />}

      <h3>Financial resolution</h3>
      {r.refund ? (
        <p>{r.refund.refundNumber} · {r.refund.method} · <strong>{r.refund.status}</strong> · {money(r.refund.amountMinor)}{r.refund.failureCode ? ` · ${r.refund.failureCode}` : ''}</p>
      ) : <p>Pending.</p>}
      {r.refundPayout && (
        <CodPayoutPanel
          returnId={id}
          payout={r.refundPayout}
          refund={r.refund}
          canRefund={canRefund}
          busy={actState.busy}
          run={run}
        />
      )}
      {r.creditNote && <p>Credit note {r.creditNote.creditNoteNumber} · {r.creditNote.type} · {money(r.creditNote.amountMinor)} · treatment {r.creditNote.treatmentStatus}</p>}
      {r.exchangeTransaction && <p>Exchange {r.exchangeTransaction.number} · {r.exchangeTransaction.status} · reserved {money(r.exchangeTransaction.eligibleValueMinor)}{r.exchangeTransaction.newExchangeOrderId ? ` · new order ${r.exchangeTransaction.newExchangeOrderId}` : ''}</p>}
      {r.replacementFulfillment && <p>Replacement fulfilment {r.replacementFulfillment.number} · {r.replacementFulfillment.status}</p>}
      <InlineAlert tone="info">Final GST / accounting treatment of any credit note requires accountant review (LEGAL_ACCOUNTING_REVIEW_REQUIRED).</InlineAlert>

      <h3>Audit timeline</h3>
      <div className="table-wrap">
        <table className="data-table">
          <thead><tr><th>Event</th><th>From → To</th><th>Actor</th><th>At</th></tr></thead>
          <tbody>
            {r.auditTimeline.map((e, i) => (
              <tr key={i}>
                <td>{e.eventType}</td>
                <td>{e.fromStatus || '—'} → {e.toStatus || '—'}</td>
                <td>{e.actorType}</td>
                <td>{when(e.at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </PageShell>
  );
}

// Phase 2 · Slice 19 — RVP QC 3.0. The frozen custom_qc config + the pickup
// agent's answers. MANUAL_REVIEW means the config could not be built (usually
// the Delhivery question mapping is not done yet) and staff run QC by hand.
function QcSnapshotPanel({ snap }) {
  const qs = (snap.customQc || []).flatMap((it) => it.questions || []);
  return (
    <>
      <h3>RVP QC 3.0</h3>
      <p>
        Build: <strong>{snap.buildStatus}</strong>{snap.buildError ? ` · ${snap.buildError}` : ''}
        {' · '}QC result: <strong>{snap.qcStatus}</strong>
        {snap.qcSource ? ` (${snap.qcSource})` : ''}
        {' · '}version {snap.qcVersion}
        {snap.evidence && <> · <a href={snap.evidence.url || snap.evidence.contentPath} target="_blank" rel="noreferrer">QC image</a></>}
      </p>
      {snap.buildStatus === 'MANUAL_REVIEW'
        ? <InlineAlert tone="warn">Provider QC config unavailable — record QC manually with the QC Pass / QC Fail buttons above.</InlineAlert>
        : (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Question</th><th>Required</th><th>Expected</th><th>Agent answer</th></tr></thead>
              <tbody>
                {qs.map((q) => {
                  const ans = (snap.qcResult || []).find((a) => a.questionId === (q.client_question_id || q.questions_id));
                  const failed = (snap.failureDetails || []).some((f) => f.questionId === (q.client_question_id || q.questions_id));
                  return (
                    <tr key={q.client_question_id || q.questions_id} style={failed ? { color: 'var(--danger, #c00)' } : undefined}>
                      <td>{q.prompt || q.client_question_id}</td>
                      <td>{q.required ? 'yes' : 'info'}</td>
                      <td>{(q.correct_value || []).join(', ') || '—'}</td>
                      <td>{ans ? (ans.value || []).join(', ') || '—' : 'not answered'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
    </>
  );
}

export default ReturnDetailPage;
