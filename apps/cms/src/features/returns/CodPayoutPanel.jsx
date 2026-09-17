import { useState } from 'react';
import { Button } from '../../components/ui/Button.jsx';
import { InlineAlert } from '../../components/feedback/InlineAlert.jsx';
import { adminApi } from '../../api/adminApi.js';

// COD refunds have no payment provider to call: a person moves the money and
// records what happened. This panel shows the destination the customer gave
// us and drives that lifecycle.
//
// The destination is MASKED by default. The full account number is fetched
// only on an explicit click, is never held in the page beyond that view, and
// every reveal is audited server-side — an operator should have to mean it.

const STATUS_COPY = {
  PENDING: { label: 'Awaiting payout', tone: 'warn' },
  PROCESSING: { label: 'Payout in progress', tone: 'info' },
  SUCCEEDED: { label: 'Refunded', tone: 'success' },
  FAILED: { label: 'Payout failed', tone: 'error' },
  BLOCKED: { label: 'Blocked', tone: 'error' },
};

export function CodPayoutPanel({ returnId, payout, refund, canRefund, busy, run }) {
  const [revealed, setRevealed] = useState(null);
  const [revealError, setRevealError] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');

  const status = refund?.status;
  const copy = STATUS_COPY[status] || { label: status || 'Not resolved', tone: 'info' };
  const isManual = refund?.method === 'COD_PAYOUT';

  const reveal = async () => {
    setRevealError('');
    try {
      const res = await adminApi.returns.revealPayout(returnId);
      setRevealed(res.destination);
    } catch (err) {
      setRevealError(err.message || 'Could not read the payout destination.');
    }
  };

  return (
    <section className="cod-payout">
      <h4>Refund destination</h4>
      <p className="text-faint">
        This order was cash on delivery, so there is no payment instrument to refund.
        The customer nominated where the money should go.
      </p>

      <dl className="cod-payout__facts">
        <div><dt>Method</dt><dd>{payout.method === 'UPI' ? 'UPI' : 'Bank account'}</dd></div>
        {payout.method === 'UPI'
          ? <div><dt>UPI ID</dt><dd>{revealed?.upiId || payout.upiIdMasked}</dd></div>
          : (
            <>
              <div><dt>Account holder</dt><dd>{payout.accountHolderName}</dd></div>
              <div><dt>Account number</dt><dd>{revealed?.accountNumber || payout.accountNumberMasked}</dd></div>
              <div><dt>IFSC</dt><dd>{payout.ifscCode}</dd></div>
              {payout.bankName && <div><dt>Bank</dt><dd>{payout.bankName}</dd></div>}
            </>
          )}
        {payout.submittedAt && (
          <div><dt>Submitted</dt><dd>{new Date(payout.submittedAt).toLocaleString()}</dd></div>
        )}
        <div><dt>Status</dt><dd><strong>{copy.label}</strong></dd></div>
        {refund?.payoutReference && <div><dt>Reference</dt><dd>{refund.payoutReference}</dd></div>}
        {refund?.completedAt && <div><dt>Paid at</dt><dd>{new Date(refund.completedAt).toLocaleString()}</dd></div>}
        {refund?.failureCode && <div><dt>Last failure</dt><dd>{refund.failureCode}</dd></div>}
        {refund?.payoutNote && <div><dt>Note</dt><dd>{refund.payoutNote}</dd></div>}
      </dl>

      {canRefund && !revealed && (
        <p>
          <Button variant="info" onClick={reveal}>Show full details to pay</Button>
          <span className="text-faint"> — this reveal is recorded in the audit log.</span>
        </p>
      )}
      {revealError && <InlineAlert tone="error">{revealError}</InlineAlert>}

      {canRefund && isManual && status !== 'SUCCEEDED' && (
        <div className="cod-payout__actions">
          {(status === 'PENDING' || status === 'FAILED') && (
            <Button variant="secondary" busy={busy}
              onClick={run(() => adminApi.returns.settlePayout(returnId, { action: 'START_PROCESSING', note: note || undefined }),
                'Mark this payout as in progress?')}>
              Start payout
            </Button>
          )}
          {status === 'PROCESSING' && (
            <>
              <label className="cod-payout__field">
                <span>Bank / UPI reference</span>
                <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UTR or transaction id" />
              </label>
              <label className="cod-payout__field">
                <span>Note (optional)</span>
                <input value={note} onChange={(e) => setNote(e.target.value)} />
              </label>
              <Button busy={busy} disabled={reference.trim().length < 3}
                onClick={run(() => adminApi.returns.settlePayout(returnId, { action: 'MARK_REFUNDED', payoutReference: reference.trim(), note: note || undefined }),
                  'Mark this refund as paid? This is final.')}>
                Mark refunded
              </Button>
              <Button variant="danger" busy={busy}
                onClick={run(() => adminApi.returns.settlePayout(returnId, { action: 'MARK_FAILED', note: note || undefined, failureCode: 'PAYOUT_FAILED' }),
                  'Mark this payout as failed? It stays in the queue for a retry.')}>
                Mark failed
              </Button>
            </>
          )}
        </div>
      )}

      {status === 'FAILED' && (
        <InlineAlert tone="error">
          This payout failed and the customer has not been refunded. Correct the destination
          with the customer if needed, then start the payout again.
        </InlineAlert>
      )}
      {!canRefund && (
        <InlineAlert tone="info">Paying this refund requires the returns.refund permission.</InlineAlert>
      )}
    </section>
  );
}

export default CodPayoutPanel;
