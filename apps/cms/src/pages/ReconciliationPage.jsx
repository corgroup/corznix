import { useState } from 'react';
import { PageShell } from '../layout/PageShell.jsx';
import { Button } from '../components/ui/Button.jsx';
import { InlineAlert } from '../components/feedback/InlineAlert.jsx';
import { LoadingState } from '../components/feedback/LoadingState.jsx';
import { ErrorState } from '../components/feedback/ErrorState.jsx';
import { adminApi } from '../api/adminApi.js';
import { useApiResource } from '../hooks/useApiResource.js';
import { succeeded, useMutation } from '../features/catalog/useMutation.js';
import { useAuth } from '../auth/useAuth.js';

const inr = (m) => (m == null ? '—' : `₹${(Number(m) / 100).toLocaleString('en-IN')}`);
const STATES = ['', 'OPEN', 'ACKNOWLEDGED', 'MANUAL_REVIEW', 'RESOLVED', 'REOPENED'];

export function ReconciliationPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('reconciliation.manage');
  const [status, setStatus] = useState('OPEN');
  const { status: load, data, error, reload } = useApiResource(() => adminApi.reconciliation.list(status ? { status } : {}));
  const [run, runState] = useMutation((fn) => fn());
  const [note, setNote] = useState({});

  const rows = data?.exceptions ?? [];

  return (
    <PageShell
      title="Reconciliation"
      description="Where internal financial truth disagrees with itself or with imported provider evidence. Working an exception never mutates a source record."
      actions={
        <span style={{ display: 'inline-flex', gap: 8 }}>
          <select className="form-field__input" style={{ maxWidth: 180 }} value={status} onChange={(e) => { setStatus(e.target.value); reload(); }}>
            {STATES.map((s) => <option key={s} value={s}>{s || 'All statuses'}</option>)}
          </select>
          {canManage && <Button busy={runState.busy} onClick={async () => { if (await succeeded(run(() => adminApi.reconciliation.scan()))) reload(); }}>Run scan</Button>}
        </span>
      }
    >
      <InlineAlert tone="info">
        External provider settlement reconciliation is a CSV import seam — no live settlement API is integrated. COD carrier remittance source is not available.
      </InlineAlert>
      {runState.error && <InlineAlert tone="error">{runState.error.message}</InlineAlert>}

      {load === 'loading' && <LoadingState label="Loading exceptions…" />}
      {load === 'error' && <ErrorState message={error?.message} onRetry={reload} />}
      {load === 'ready' && (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Type</th><th>Reference</th><th>Expected</th><th>Actual</th><th>Variance</th><th>Status</th><th /></tr></thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td>{e.type}</td>
                  <td><code>{e.referenceType}:{String(e.referenceId).slice(0, 18)}</code></td>
                  <td>{inr(e.expectedMinor)}</td>
                  <td>{inr(e.actualMinor)}</td>
                  <td>{e.varianceMinor == null ? '—' : inr(e.varianceMinor)}</td>
                  <td><span className={`pill pill--${e.status === 'RESOLVED' ? 'good' : e.status === 'OPEN' ? 'warn' : 'muted'}`}>{e.status}</span></td>
                  <td>
                    {canManage && e.status !== 'RESOLVED' && (
                      <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                        <button type="button" className="btn btn--secondary btn--sm" onClick={async () => { if (await succeeded(run(() => adminApi.reconciliation.act(e.id, 'ACKNOWLEDGE')))) reload(); }}>Ack</button>
                        {/* A readable minimum: squeezed between the buttons it shrank to 49px. */}
                        <input className="form-field__input control--sm" style={{ minWidth: 160, maxWidth: 220 }} aria-label="Evidence note" placeholder="Evidence note" value={note[e.id] || ''} onChange={(ev) => setNote({ ...note, [e.id]: ev.target.value })} />
                        <button type="button" className="btn btn--info btn--sm" disabled={!(note[e.id] || '').trim()} onClick={async () => { if (await succeeded(run(() => adminApi.reconciliation.act(e.id, 'RESOLVE', note[e.id])))) reload(); }}>Resolve</button>
                      </span>
                    )}
                    {e.status === 'RESOLVED' && canManage && <button type="button" className="btn btn--secondary" onClick={async () => { if (await succeeded(run(() => adminApi.reconciliation.act(e.id, 'REOPEN')))) reload(); }}>Reopen</button>}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={7} className="data-table__empty">No exceptions.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </PageShell>
  );
}

export default ReconciliationPage;
