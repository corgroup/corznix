import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageShell } from '../layout/PageShell.jsx';
import { LoadingState } from '../components/feedback/LoadingState.jsx';
import { ErrorState } from '../components/feedback/ErrorState.jsx';
import { adminApi } from '../api/adminApi.js';
import { useApiResource } from '../hooks/useApiResource.js';

const STATUSES = ['', 'ACTIVE', 'SUSPENDED', 'PENDING_PROFILE'];
const tone = (s) => (s === 'SUSPENDED' ? 'muted' : s === 'PENDING_PROFILE' ? 'warn' : 'good');

export function CustomersPage() {
  const [search, setSearch] = useState('');
  const [pending, setPending] = useState('');
  const [status, setStatus] = useState('');
  const { status: load, data, error, reload } = useApiResource(() => adminApi.customers.list({
    ...(search ? { search } : {}), ...(status ? { status } : {}),
  }));
  const rows = data?.customers ?? [];

  return (
    <PageShell
      title="Customers"
      description="One customer identity authority. Contact values are masked here; open a customer to see verified details."
      actions={
        <form
          style={{ display: 'inline-flex', gap: 8 }}
          onSubmit={(e) => { e.preventDefault(); setSearch(pending); reload(); }}
        >
          <input className="form-field__input" style={{ maxWidth: 240 }} placeholder="Name or email/phone…" value={pending} onChange={(e) => setPending(e.target.value)} />
          <select value={status} onChange={(e) => { setStatus(e.target.value); reload(); }} className="form-field__input" style={{ maxWidth: 170 }}>
            {STATUSES.map((s) => <option key={s} value={s}>{s || 'All statuses'}</option>)}
          </select>
        </form>
      }
    >
      {load === 'loading' && <LoadingState label="Loading customers…" />}
      {load === 'error' && <ErrorState message={error?.message} onRetry={reload} />}
      {load === 'ready' && (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Orders</th><th>Status</th><th>Joined</th></tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td><Link to={`/customers/${c.id}`}>{c.name || '—'}</Link></td>
                  <td>{c.email || '—'}</td>
                  <td>{c.phone || '—'}</td>
                  <td>{c.orderCount}</td>
                  <td><span className={`pill pill--${tone(c.status)}`}>{c.status}</span></td>
                  <td>{new Date(c.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={6} className="data-table__empty">No customers.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </PageShell>
  );
}

export default CustomersPage;
