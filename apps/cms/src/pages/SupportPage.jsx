import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageShell } from '../layout/PageShell.jsx';
import { LoadingState } from '../components/feedback/LoadingState.jsx';
import { ErrorState } from '../components/feedback/ErrorState.jsx';
import { adminApi } from '../api/adminApi.js';
import { useApiResource } from '../hooks/useApiResource.js';

const STATUSES = ['', 'OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'WAITING_INTERNAL', 'RESOLVED', 'CLOSED'];
const tone = (s) => (['RESOLVED', 'CLOSED'].includes(s) ? 'good' : s === 'OPEN' ? 'warn' : 'muted');
const pTone = (p) => (p === 'URGENT' ? 'warn' : p === 'HIGH' ? 'warn' : 'muted');

export function SupportPage() {
  const [status, setStatus] = useState('');
  const [scope, setScope] = useState('');
  const filters = { ...(status ? { status } : {}), ...(scope === 'unassigned' ? { unassigned: true } : {}) };
  const { status: load, data, error, reload } = useApiResource(() => adminApi.support.list(filters));
  const rows = data?.tickets ?? [];

  return (
    <PageShell
      title="Support Tickets"
      description="Customer-service cases. Support references orders and returns — it never changes their lifecycle."
      actions={
        <span style={{ display: 'inline-flex', gap: 8 }}>
          <select value={status} onChange={(e) => { setStatus(e.target.value); reload(); }} className="form-field__input" style={{ maxWidth: 200 }}>
            {STATUSES.map((s) => <option key={s} value={s}>{s ? s.replaceAll('_', ' ') : 'All statuses'}</option>)}
          </select>
          <select value={scope} onChange={(e) => { setScope(e.target.value); reload(); }} className="form-field__input" style={{ maxWidth: 160 }}>
            <option value="">All</option>
            <option value="unassigned">Unassigned</option>
          </select>
        </span>
      }
    >
      {load === 'loading' && <LoadingState label="Loading tickets…" />}
      {load === 'error' && <ErrorState message={error?.message} onRetry={reload} />}
      {load === 'ready' && (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Ticket</th><th>Subject</th><th>Category</th><th>Priority</th><th>Assigned</th><th>Status</th><th>Updated</th></tr></thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td><Link to={`/support/${t.id}`}>{t.ticketNumber}</Link></td>
                  <td>{t.subject}</td>
                  <td>{t.category}</td>
                  <td><span className={`pill pill--${pTone(t.priority)}`}>{t.priority}</span></td>
                  <td>{t.assignedEmail || '—'}</td>
                  <td><span className={`pill pill--${tone(t.status)}`}>{t.status.replaceAll('_', ' ')}</span></td>
                  <td>{new Date(t.updatedAt).toLocaleDateString()}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={7} className="data-table__empty">No tickets.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </PageShell>
  );
}

export default SupportPage;
