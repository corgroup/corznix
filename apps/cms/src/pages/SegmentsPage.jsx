import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PageShell } from '../layout/PageShell.jsx';
import { Button } from '../components/ui/Button.jsx';
import { InlineAlert } from '../components/feedback/InlineAlert.jsx';
import { LoadingState } from '../components/feedback/LoadingState.jsx';
import { ErrorState } from '../components/feedback/ErrorState.jsx';
import { adminApi } from '../api/adminApi.js';
import { useApiResource } from '../hooks/useApiResource.js';
import { useMutation } from '../features/catalog/useMutation.js';
import { useAuth } from '../auth/useAuth.js';

const slugify = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

export function SegmentsPage() {
  const nav = useNavigate();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('segments.manage');
  const { status, data, error, reload } = useApiResource(() => adminApi.segments.list());
  const rows = data?.segments ?? [];
  const [name, setName] = useState('');
  const [create, createState] = useMutation((body) => adminApi.segments.create(body));

  const submit = async () => {
    // A new segment starts with a single always-true-ish placeholder condition
    // the user immediately edits on the detail screen.
    const seg = await create({
      segmentKey: slugify(name),
      name: name.trim(),
      definition: { match: 'ALL', conditions: [{ attribute: 'customer_status', operator: 'EQ', value: 'ACTIVE' }] },
    });
    setName('');
    reload();
    nav(`/segments/${seg.id}`);
  };

  return (
    <PageShell
      title="Customer Segments"
      description="Saved rule definitions for marketing audiences and promotion eligibility. Rules are structured — the CMS never sends SQL."
    >
      {canManage && (
        <div className="editor-actions" style={{ marginBottom: 20 }}>
          <input className="form-field__input" style={{ maxWidth: 320 }} placeholder="New segment name" value={name} onChange={(e) => setName(e.target.value)} />
          <Button busy={createState.busy} disabled={name.trim().length < 2} onClick={submit}>Create</Button>
        </div>
      )}
      {createState.error && <InlineAlert tone="error">{createState.error.message}</InlineAlert>}

      {status === 'loading' && <LoadingState label="Loading segments…" />}
      {status === 'error' && <ErrorState message={error?.message} onRetry={reload} />}
      {status === 'ready' && (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Name</th><th>Key</th><th>Match</th><th>Conditions</th><th>Rev</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td><Link to={`/segments/${s.id}`}>{s.name}</Link></td>
                  <td><code>{s.key}</code></td>
                  <td>{s.matchMode || '—'}</td>
                  <td>{s.definition?.conditions?.length ?? 0}</td>
                  <td>{s.revision ?? '—'}</td>
                  <td><span className={`pill pill--${s.status === 'ACTIVE' ? 'good' : 'muted'}`}>{s.status}</span></td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={6} className="data-table__empty">No segments yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </PageShell>
  );
}

export default SegmentsPage;
