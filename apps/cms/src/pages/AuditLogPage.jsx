import { useState } from 'react';
import { PageShell } from '../layout/PageShell.jsx';
import { LoadingState } from '../components/feedback/LoadingState.jsx';
import { ErrorState } from '../components/feedback/ErrorState.jsx';
import { adminApi } from '../api/adminApi.js';
import { useApiResource } from '../hooks/useApiResource.js';
import './AuditLogPage.css';

// WP-12 / GAP-ORD-06 — read-only viewer over staff_audit_logs. The trail is
// append-only and written by every admin module; nothing here mutates it.
const humanAction = (a) => (a ? a.replaceAll('_', ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()) : '—');

function MetaCell({ metadata }) {
  const [open, setOpen] = useState(false);
  if (metadata == null || (typeof metadata === 'object' && Object.keys(metadata).length === 0)) {
    return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  }
  const text = JSON.stringify(metadata, null, 2);
  const short = JSON.stringify(metadata);
  return (
    <button
      type="button"
      className="btn btn--ghost btn--sm"
      style={{ maxWidth: 320, textAlign: 'left', whiteSpace: open ? 'pre-wrap' : 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
      onClick={() => setOpen((v) => !v)}
      title="Toggle full metadata"
    >
      {open ? text : short.length > 60 ? `${short.slice(0, 60)}…` : short}
    </button>
  );
}

export function AuditLogPage() {
  const facets = useApiResource(() => adminApi.audit.facets());

  const [pendingQ, setPendingQ] = useState('');
  const [q, setQ] = useState('');
  const [action, setAction] = useState('');
  const [resourceType, setResourceType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [offset, setOffset] = useState(0);
  const limit = 50;

  const { status, data, error, reload } = useApiResource(() => adminApi.audit.list({
    ...(q ? { q } : {}),
    ...(action ? { action } : {}),
    ...(resourceType ? { resourceType } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    limit,
    offset,
  }));

  const rows = data?.logs ?? [];
  const total = data?.total ?? 0;

  const apply = (patch) => {
    setOffset(0);
    if ('q' in patch) setQ(patch.q);
    if ('action' in patch) setAction(patch.action);
    if ('resourceType' in patch) setResourceType(patch.resourceType);
    if ('from' in patch) setFrom(patch.from);
    if ('to' in patch) setTo(patch.to);
    reload();
  };

  const actions = facets.data?.actions ?? [];
  const resourceTypes = facets.data?.resourceTypes ?? [];

  return (
    <PageShell
      title="Audit Log"
      description="Every privileged action across the CMS, oldest hidden below newest. Append-only — this view never edits the trail."
    >
      {/* The filters used to sit in the header's actions slot, which never
          shrinks: five fixed-width controls pushed the whole page wider than
          the window. As a toolbar row they wrap like every other list page. */}
      <form className="wb-toolbar" onSubmit={(e) => { e.preventDefault(); apply({ q: pendingQ }); }}>
        <input className="form-field__input wb-toolbar__search" type="search" aria-label="Search the audit log"
          placeholder="Search action, id or email…" value={pendingQ} onChange={(e) => setPendingQ(e.target.value)} />
        <select className="form-field__input audit-filter" aria-label="Action" value={action}
          onChange={(e) => apply({ action: e.target.value })}>
          <option value="">All actions</option>
          {actions.map((a) => <option key={a.value} value={a.value}>{a.value} ({a.n})</option>)}
        </select>
        <select className="form-field__input audit-filter" aria-label="Resource type" value={resourceType}
          onChange={(e) => apply({ resourceType: e.target.value })}>
          <option value="">All resource types</option>
          {resourceTypes.map((r) => <option key={r.value} value={r.value}>{r.value} ({r.n})</option>)}
        </select>
        <input type="date" className="form-field__input audit-filter--date" aria-label="From date" value={from}
          onChange={(e) => apply({ from: e.target.value })} />
        <input type="date" className="form-field__input audit-filter--date" aria-label="To date" value={to}
          onChange={(e) => apply({ to: e.target.value })} />
      </form>
      {status === 'loading' && <LoadingState label="Loading audit log…" />}
      {status === 'error' && <ErrorState message={error?.message} onRetry={reload} />}
      {status === 'ready' && (
        <>
          <div className="table-wrap"><table className="data-table">
            <thead>
              <tr><th>When</th><th>Actor</th><th>Action</th><th>Resource</th><th>IP</th><th>Metadata</th></tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{new Date(row.at).toLocaleString()}</td>
                  <td>
                    {row.actor.name || row.actor.email || 'system'}
                    {row.actor.email && row.actor.name && (
                      <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>{row.actor.email}</div>
                    )}
                  </td>
                  <td title={row.action}>{humanAction(row.action)}</td>
                  <td>
                    {row.resourceType || '—'}
                    {row.resourceId && <div style={{ color: 'var(--text-muted)', fontSize: 12 }}><code>{row.resourceId}</code></div>}
                  </td>
                  <td style={{ color: 'var(--text-muted)' }}>{row.ipAddress || '—'}</td>
                  <td><MetaCell metadata={row.metadata} /></td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={6} className="data-table__empty">No audit entries match.</td></tr>}
            </tbody>
          </table></div>

          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 12, color: 'var(--text-muted)' }}>
            <span>{total} entr{total === 1 ? 'y' : 'ies'}</span>
            <button type="button" className="btn btn--secondary" disabled={offset === 0}
              onClick={() => { setOffset(Math.max(0, offset - limit)); reload(); }}>Previous</button>
            <button type="button" className="btn btn--secondary" disabled={offset + limit >= total}
              onClick={() => { setOffset(offset + limit); reload(); }}>Next</button>
          </div>
        </>
      )}
    </PageShell>
  );
}

export default AuditLogPage;
