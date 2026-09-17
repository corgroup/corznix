import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PageShell } from '../layout/PageShell.jsx';
import { Button } from '../components/ui/Button.jsx';
import { InlineAlert } from '../components/feedback/InlineAlert.jsx';
import { LoadingState } from '../components/feedback/LoadingState.jsx';
import { ErrorState } from '../components/feedback/ErrorState.jsx';
import { adminApi } from '../api/adminApi.js';
import { useApiResource } from '../hooks/useApiResource.js';
import { useMutation } from '../features/catalog/useMutation.js';
import { useAuth } from '../auth/useAuth.js';

const money = (m) => `₹${(Number(m || 0) / 100).toFixed(2)}`;
const when = (d) => (d ? new Date(d).toLocaleString() : '—');

export function CustomerDetailPage() {
  const { id } = useParams();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('customers.manage');
  const { status, data: c, error, reload } = useApiResource(() => adminApi.customers.get(id));
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');

  const [addNote, noteState] = useMutation(() => adminApi.customers.addNote(id, note));
  const [setStatus, statusState] = useMutation((next) => adminApi.customers.setStatus(id, next, reason));

  if (status === 'loading') return <PageShell title="Customer"><LoadingState label="Loading customer…" /></PageShell>;
  if (status === 'error') return <PageShell title="Customer"><ErrorState message={error?.message} onRetry={reload} /></PageShell>;

  const actionErr = noteState.error || statusState.error;

  return (
    <PageShell title={c.name || 'Customer'} description={`${c.status} · joined ${new Date(c.createdAt).toLocaleDateString()} · ${c.activeSessionCount} active session(s)`}>
      {actionErr && <InlineAlert tone="error">{actionErr.message}</InlineAlert>}

      <h3>Identity</h3>
      <p>Verified contacts (read-only — changes go through re-verification):</p>
      <ul>
        {c.contacts.map((ct, i) => <li key={i}>{ct.type}: {ct.value} {ct.verified ? '✓ verified' : '(unverified)'}</li>)}
        {c.identities.map((idn, i) => <li key={`id${i}`}>Login: {idn.provider}</li>)}
      </ul>

      {canManage && (
        <div className="editor-actions" style={{ marginBottom: 24 }}>
          {c.status === 'ACTIVE' && (
            <>
              <input className="form-field__input" style={{ maxWidth: 280 }} placeholder="Reason for suspension…" value={reason} onChange={(e) => setReason(e.target.value)} />
              <Button variant="warning" busy={statusState.busy} disabled={reason.trim().length < 3}
                onClick={async () => { if (window.confirm('Suspend this customer? All their sessions will be revoked.')) { await setStatus('SUSPENDED'); reload(); } }}>Suspend</Button>
            </>
          )}
          {c.status === 'SUSPENDED' && (
            <>
              <input className="form-field__input" style={{ maxWidth: 280 }} placeholder="Reason for reactivation…" value={reason} onChange={(e) => setReason(e.target.value)} />
              <Button variant="success" busy={statusState.busy} disabled={reason.trim().length < 3} onClick={async () => { await setStatus('ACTIVE'); reload(); }}>Reactivate</Button>
            </>
          )}
        </div>
      )}

      <h3>Store credit</h3>
      <p><strong>{money(c.storeCredit.balanceMinor)}</strong> balance</p>

      <h3>Marketing preferences</h3>
      <p>{c.subscriber ? `Newsletter: ${c.subscriber.status} (${c.subscriber.source})` : 'Not a newsletter subscriber.'}</p>
      <ul>
        {c.consent.map((s, i) => <li key={i}>{s.channel} · {s.purpose}: {s.granted ? 'granted' : 'not granted'}</li>)}
        {c.consent.length === 0 && <li>No consent recorded.</li>}
      </ul>

      <h3>Segments</h3>
      <p>{c.segments && c.segments.length
        ? c.segments.map((s) => s.name).join(', ')
        : 'Not in any active segment.'}</p>

      <h3>Reviews ({c.reviews?.length ?? 0})</h3>
      <ul>
        {(c.reviews ?? []).map((r) => <li key={r.id}>{'★'.repeat(r.rating)} — {r.status}{r.title ? ` · ${r.title}` : ''}</li>)}
        {(c.reviews ?? []).length === 0 && <li>No reviews.</li>}
      </ul>

      <h3>Orders ({c.orders.length})</h3>
      <div className="table-wrap">
        <table className="data-table">
          <thead><tr><th>Order</th><th>Status</th><th>Total</th><th>Placed</th></tr></thead>
          <tbody>
            {c.orders.map((o) => (
              <tr key={o.id}><td><Link to={`/orders/${o.id}`}>{o.orderNumber}</Link>{o.isExchangeOrder ? ' (exchange)' : ''}</td><td>{o.status}</td><td>{money(o.totalMinor)}</td><td>{when(o.placedAt)}</td></tr>
            ))}
            {c.orders.length === 0 && <tr><td colSpan={4} className="data-table__empty">No orders.</td></tr>}
          </tbody>
        </table>
      </div>

      <h3>Returns &amp; exchanges ({c.returns.length})</h3>
      <div className="table-wrap">
        <table className="data-table">
          <thead><tr><th>Request</th><th>Type</th><th>Status</th></tr></thead>
          <tbody>
            {c.returns.map((r) => (
              <tr key={r.id}><td><Link to={`/returns/${r.id}`}>{r.requestNumber}</Link></td><td>{r.requestType.replaceAll('_', ' ')}</td><td>{r.status.replaceAll('_', ' ')}</td></tr>
            ))}
            {c.returns.length === 0 && <tr><td colSpan={3} className="data-table__empty">None.</td></tr>}
          </tbody>
        </table>
      </div>

      <h3>Internal notes</h3>
      {canManage && (
        <div className="editor-actions" style={{ marginBottom: 12 }}>
          <input className="form-field__input" style={{ maxWidth: 420 }} placeholder="Add an internal note (staff-only)…" value={note} onChange={(e) => setNote(e.target.value)} />
          <Button variant="soft" busy={noteState.busy} disabled={!note.trim()} onClick={async () => { await addNote(); setNote(''); reload(); }}>Add note</Button>
        </div>
      )}
      <ul>
        {c.notes.map((n, i) => <li key={i}>{when(n.at)} — {n.authorEmail || 'staff'}: {n.body}</li>)}
        {c.notes.length === 0 && <li>No notes.</li>}
      </ul>

      <h3>Status history</h3>
      <ul>
        {c.statusHistory.map((s, i) => <li key={i}>{when(s.at)} — {s.from} → {s.to} ({s.reason}) by {s.by || 'staff'}</li>)}
        {c.statusHistory.length === 0 && <li>No status changes.</li>}
      </ul>
    </PageShell>
  );
}

export default CustomerDetailPage;
