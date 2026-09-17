import { useState } from 'react';
import { PageShell } from '../layout/PageShell.jsx';
import { LoadingState } from '../components/feedback/LoadingState.jsx';
import { ErrorState } from '../components/feedback/ErrorState.jsx';
import { adminApi } from '../api/adminApi.js';
import { useApiResource } from '../hooks/useApiResource.js';

const STATUSES = ['', 'SUBSCRIBED', 'PENDING_CONFIRMATION', 'UNSUBSCRIBED'];
const tone = (s) => (s === 'SUBSCRIBED' ? 'good' : s === 'UNSUBSCRIBED' ? 'muted' : 'warn');

export function SubscribersPage() {
  const [status, setStatus] = useState('');
  const { status: load, data, error, reload } = useApiResource(() => adminApi.subscribers.list(status ? { status } : undefined));
  const rows = data?.subscribers ?? [];

  return (
    <PageShell
      title="Subscribers & Consent"
      description={`Newsletter subscribers. Consent is channel + purpose aware and append-only. Double opt-in: ${data?.doubleOptInPolicy || '—'} (business/legal to confirm).`}
      actions={
        <select value={status} onChange={(e) => { setStatus(e.target.value); reload(); }} className="form-field__input" style={{ maxWidth: 200 }}>
          {STATUSES.map((s) => <option key={s} value={s}>{s || 'All statuses'}</option>)}
        </select>
      }
    >
      {load === 'loading' && <LoadingState label="Loading subscribers…" />}
      {load === 'error' && <ErrorState message={error?.message} onRetry={reload} />}
      {load === 'ready' && (
        <div className="table-wrap">
          <table className="data-table">
            {/* `contact` rather than `email`: a subscriber can be a WhatsApp
                number since migration 102, and those rows carry no email at
                all — reading s.email would render them as blank lines. */}
            <thead><tr><th>Contact</th><th>Channel</th><th>Status</th><th>Source</th><th>Linked customer</th><th>Since</th></tr></thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td>{s.contact || s.email || '—'}</td>
                  <td><span className={`pill pill--${s.channel === 'WHATSAPP' ? 'success' : 'neutral'}`}>{s.channel || 'EMAIL'}</span></td>
                  <td><span className={`pill pill--${tone(s.status)}`}>{s.status.replaceAll('_', ' ')}</span></td>
                  <td>{s.source}</td>
                  <td>{s.customerId ? 'yes' : '—'}</td>
                  <td>{new Date(s.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={6} className="data-table__empty">No subscribers.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </PageShell>
  );
}

export default SubscribersPage;
