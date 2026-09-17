import { useState } from 'react';
import { PageShell } from '../layout/PageShell.jsx';
import { Button } from '../components/ui/Button.jsx';
import { InlineAlert } from '../components/feedback/InlineAlert.jsx';
import { LoadingState } from '../components/feedback/LoadingState.jsx';
import { ErrorState } from '../components/feedback/ErrorState.jsx';
import { StatStrip } from '../components/ui/StatStrip.jsx';
import { adminApi } from '../api/adminApi.js';
import { useApiResource } from '../hooks/useApiResource.js';
import { succeeded, useMutation } from '../features/catalog/useMutation.js';
import { useAuth } from '../auth/useAuth.js';
import { formatRelative } from '../utils/format.js';
import { InstagramTab } from './providers/InstagramTab.jsx';
import './ProvidersPage.css';

const TABS = ['Overview', 'Instagram', 'Webhooks', 'Outbox', 'Attempts', 'Shipping pricing'];

const when = (v) => (v ? new Date(v).toLocaleString() : '—');
const rel = (v) => (v ? formatRelative(v) : '—');
const rupees = (minor) => (Number(minor || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const shortId = (v) => (v ? String(v).slice(0, 10) : '');

// humanize a future timestamp: "in 2 min", "today 4:32 PM", exact in tooltip
function untilLabel(v) {
  if (!v) return '—';
  const t = new Date(v).getTime();
  const diff = t - Date.now();
  if (diff <= 0) return 'due now';
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `in ${mins} min`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `in ${hrs} hr`;
  return new Date(v).toLocaleString();
}

// ---------------------------------------------------------------------------
// shared bits
// ---------------------------------------------------------------------------
function Hero({ title, text, bullets }) {
  return (
    <div className="pv-hero">
      <span className="pv-hero__icon" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M4 7h16M4 12h16M4 17h10" strokeLinecap="round" />
        </svg>
      </span>
      <div className="pv-hero__body">
        <h3 className="pv-hero__title">{title}</h3>
        <p className="pv-hero__text">{text}</p>
        {bullets?.length > 0 && <ul className="pv-hero__bullets">{bullets.map((b) => <li key={b}>{b}</li>)}</ul>}
      </div>
    </div>
  );
}

const capIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" />
  </svg>
);

// ---------------------------------------------------------------------------
// OVERVIEW
// ---------------------------------------------------------------------------
const HEALTH_BADGE = {
  HEALTHY: ['ok', 'Healthy'],
  DEGRADED: ['retrying', 'Degraded'],
  UNAVAILABLE: ['bad', 'Unavailable'],
  MISCONFIGURED: ['bad', 'Misconfigured'],
  UNKNOWN: ['muted', 'Unknown'],
};
function Badge({ tone, children }) {
  return <span className={`pv-badge pv-badge--${tone}`}>{children}</span>;
}

function Overview() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('providers.manage');
  const { status, data, error, reload } = useApiResource(() => adminApi.providers.overview());
  const [run, state] = useMutation((fn) => fn());
  const [q, setQ] = useState('');
  const [capFilter, setCapFilter] = useState('');
  const [healthFilter, setHealthFilter] = useState('');
  const [edit, setEdit] = useState(null);

  if (status === 'loading') return <LoadingState label="Loading providers…" />;
  if (status === 'error') return <ErrorState message={error?.message} onRetry={reload} />;
  const rows = data ?? [];

  const capabilities = [...new Set(rows.map((r) => r.capability))].sort();
  const enabled = rows.filter((r) => r.enabled).length;
  const issues = rows.filter((r) => ['UNAVAILABLE', 'MISCONFIGURED'].includes(r.health)).length;
  const lastActivity = rows
    .flatMap((r) => [r.lastSuccessAt, r.lastFailureAt])
    .filter(Boolean)
    .sort((a, b) => new Date(b) - new Date(a))[0];

  const shown = rows.filter((r) => {
    const s = q.trim().toLowerCase();
    if (s && !(`${r.label} ${r.providerKey} ${r.capability}`.toLowerCase().includes(s))) return false;
    if (capFilter && r.capability !== capFilter) return false;
    if (healthFilter && r.health !== healthFilter) return false;
    return true;
  });

  // A refused toggle (e.g. "Cannot enable Razorpay — credentials missing") is
  // shown by the error alert below; it used to also throw uncaught.
  const toggle = async (p) => {
    if (await succeeded(run(() => adminApi.providers.update(p.capability, p.providerKey, { enabled: !p.enabled })))) reload();
  };

  return (
    <>
      <StatStrip
        min={170}
        cards={[
          { label: 'Total providers', value: rows.length },
          { label: 'Enabled', value: enabled, hint: `${rows.length - enabled} disabled` },
          { label: 'Issues', value: issues, tone: issues ? 'warn' : undefined, hint: issues ? 'unavailable / misconfigured' : 'none' },
          { label: 'Last provider activity', value: lastActivity ? rel(lastActivity) : '—' },
        ]}
      />

      <div className="wb-toolbar">
        <input className="wb-toolbar__search" placeholder="Search provider, key or capability…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="wb-toolbar__search" style={{ flex: '0 1 160px' }} value={capFilter} onChange={(e) => setCapFilter(e.target.value)} aria-label="Capability">
          <option value="">All capabilities</option>
          {capabilities.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="wb-toolbar__search" style={{ flex: '0 1 150px' }} value={healthFilter} onChange={(e) => setHealthFilter(e.target.value)} aria-label="Health">
          <option value="">All health</option>
          {Object.keys(HEALTH_BADGE).map((h) => <option key={h} value={h}>{HEALTH_BADGE[h][1]}</option>)}
        </select>
        <span className="wb-toolbar__spacer" />
        {canManage && (
          <Button variant="secondary" busy={state.busy} onClick={async () => { if (await succeeded(run(() => adminApi.providers.recomputeHealth()))) reload(); }}>
            Recompute health
          </Button>
        )}
      </div>
      {state.error && <InlineAlert tone="error">{state.error.message}</InlineAlert>}

      <div className="table-wrap">
        <table className="data-table">
          <thead><tr>
            <th>Provider</th><th>Capability</th><th>Enabled</th><th>Priority</th>
            <th>Credentials</th><th>Health</th><th>Last success</th><th>Last failure</th><th>Cfg v</th><th />
          </tr></thead>
          <tbody>
            {shown.map((p) => {
              const [tone, label] = HEALTH_BADGE[p.health] || HEALTH_BADGE.UNKNOWN;
              return (
                <tr key={`${p.capability}:${p.providerKey}`}>
                  <td>
                    <div className="pv-stack">
                      <span className="pv-stack__main">{p.label}</span>
                      <span className="pv-stack__sub">{p.providerKey}</span>
                    </div>
                  </td>
                  <td><span className="pv-cap"><span className="pv-cap__icon">{capIcon()}</span>{p.capability}</span></td>
                  <td>
                    <label className="pv-switch" title={canManage ? 'Toggle new operations' : 'Requires providers.manage'}>
                      <input type="checkbox" checked={p.enabled} disabled={!canManage || state.busy} onChange={() => toggle(p)} aria-label={`${p.label} enabled`} />
                      <span className="pv-switch__track" />
                    </label>
                  </td>
                  <td>{p.priority ?? '—'}</td>
                  <td><Badge tone={p.secretStatus === 'CONFIGURED' ? 'ok' : p.secretStatus === 'NOT_CONFIGURED' ? 'muted' : 'bad'}>{p.secretStatus}</Badge></td>
                  <td><Badge tone={tone}>{label}</Badge></td>
                  <td className="pv-time">{rel(p.lastSuccessAt)}</td>
                  <td className="pv-time">{rel(p.lastFailureAt)}</td>
                  <td>{p.configVersion}</td>
                  <td>{canManage && (
                    <button type="button" className="linkish" onClick={() => setEdit({ capability: p.capability, providerKey: p.providerKey, label: p.label, priority: p.priority ?? 1000, note: '' })}>
                      Edit
                    </button>
                  )}</td>
                </tr>
              );
            })}
            {shown.length === 0 && <tr><td colSpan={10} className="data-table__empty">No providers match these filters.</td></tr>}
          </tbody>
        </table>
      </div>

      {edit && (
        <>
          <div className="pv-drawer-backdrop" onClick={() => setEdit(null)} />
          <aside className="pv-drawer" role="dialog" aria-label={`Edit ${edit.label}`}>
            <div className="pv-drawer__head">
              <h3 className="pv-drawer__title">{edit.label}</h3>
              <button type="button" className="pv-drawer__close" onClick={() => setEdit(null)} aria-label="Close">×</button>
            </div>
            <div className="pv-drawer__body">
              <InlineAlert tone="info">Secrets and provider endpoints are never editable here — they live in the backend environment.</InlineAlert>
              <div className="pv-money-field" style={{ marginTop: 16 }}>
                <label htmlFor="pv-priority">Priority</label>
                <input id="pv-priority" className="wb-toolbar__search" style={{ maxWidth: 120 }} type="number"
                  value={edit.priority} onChange={(e) => setEdit({ ...edit, priority: Number(e.target.value) })} />
              </div>
              <div style={{ marginTop: 12 }}>
                <label className="pv-card__label" htmlFor="pv-note">Change note (audit trail)</label>
                <input id="pv-note" className="wb-toolbar__search" value={edit.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })} />
              </div>
            </div>
            {/* The page's alert sits behind this drawer, so a refused save is shown here. */}
            {state.error && <InlineAlert tone="error">{state.error.message}</InlineAlert>}
            <div className="pv-drawer__actions">
              <Button busy={state.busy} onClick={async () => {
                if (!(await succeeded(run(() => adminApi.providers.update(edit.capability, edit.providerKey, { priority: edit.priority, note: edit.note }))))) return;
                setEdit(null); reload();
              }}>Save — bumps config version</Button>
              <Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button>
            </div>
          </aside>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// WEBHOOKS
// ---------------------------------------------------------------------------
const WH_PROCESSING = {
  APPLIED: ['ok', 'Applied'], REPLAYED: ['ok', 'Replayed'], IGNORED: ['muted', 'Ignored'],
  PENDING: ['retrying', 'Pending'], FAILED: ['bad', 'Failed'],
};
function Webhooks() {
  const { hasPermission } = useAuth();
  const canReplay = hasPermission('provider.webhooks.replay');
  const [statusF, setStatusF] = useState('');
  return <WebhooksInner key={statusF} statusF={statusF} setStatusF={setStatusF} canReplay={canReplay} />;
}
function WebhooksInner({ statusF, setStatusF, canReplay }) {
  const { status, data, error, reload } = useApiResource(
    () => adminApi.providers.webhooks({ limit: 150, ...(statusF ? { processingStatus: statusF } : {}) }),
  );
  const [run, state] = useMutation((fn) => fn());
  const [detail, setDetail] = useState(null);

  const rows = data?.events ?? [];
  const count = (s) => rows.filter((r) => r.processing_status === s).length;

  return (
    <>
      <Hero
        title="Webhook inbox"
        text="Inbound provider events (payment status, carrier scans, delivery proof). Each is signature-verified, stored, then applied to the domain."
        bullets={['Verify signatures', 'Track processing status', 'Replay failed events']}
      />
      {status === 'ready' && (
        <StatStrip
          min={150}
          cards={[
            { label: 'In view', value: rows.length, hint: 'most recent 150' },
            { label: 'Applied', value: count('APPLIED') + count('REPLAYED'), tone: 'ok' },
            { label: 'Pending', value: count('PENDING') },
            { label: 'Failed', value: count('FAILED'), tone: count('FAILED') ? 'warn' : undefined },
          ]}
        />
      )}
      <div className="wb-toolbar">
        <select className="wb-toolbar__search" style={{ flex: '0 1 200px' }} value={statusF} onChange={(e) => setStatusF(e.target.value)} aria-label="Processing status">
          <option value="">All statuses</option>
          {Object.keys(WH_PROCESSING).map((s) => <option key={s} value={s}>{WH_PROCESSING[s][1]}</option>)}
        </select>
        <span className="wb-toolbar__spacer" />
        <Button variant="secondary" onClick={reload}>Refresh</Button>
      </div>
      {state.error && <InlineAlert tone="error">{state.error.message}</InlineAlert>}

      {status === 'loading' && <LoadingState label="Loading webhook inbox…" />}
      {status === 'error' && <ErrorState message={error?.message} onRetry={reload} />}
      {status === 'ready' && (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Received</th><th>Capability / Provider</th><th>Event</th><th>Verified</th><th>Processing</th><th>Resource</th><th>Attempts</th><th>Error</th><th /></tr></thead>
            <tbody>
              {rows.map((e) => {
                const [tone, label] = WH_PROCESSING[e.processing_status] || ['muted', e.processing_status];
                return (
                  <tr key={e.id}>
                    <td className="pv-time" title={when(e.received_at)}>{rel(e.received_at)}</td>
                    <td><div className="pv-stack"><span className="pv-stack__main">{e.capability}</span><span className="pv-stack__sub">{e.provider_key}</span></div></td>
                    <td>{e.normalized_event_type || '—'}</td>
                    <td><Badge tone={e.verification_status === 'VERIFIED' ? 'ok' : 'bad'}>{e.verification_status}</Badge></td>
                    <td><Badge tone={tone}>{label}</Badge></td>
                    <td>{e.resource_type ? <div className="pv-stack"><span className="pv-stack__main">{e.resource_type}</span><span className="pv-stack__sub">{shortId(e.resource_id)}</span></div> : '—'}</td>
                    <td>{e.attempt_count} {e.attempt_count === 1 ? 'attempt' : 'attempts'}</td>
                    <td>{e.last_error_code ? <span className="pv-err" title={e.last_error_code}>{e.last_error_code}</span> : '—'}</td>
                    <td>
                      <button type="button" className="linkish" onClick={() => setDetail(e)}>Details</button>
                      {canReplay && ['PENDING', 'FAILED', 'IGNORED'].includes(e.processing_status) && (
                        <button type="button" className="linkish" style={{ marginLeft: 8 }} disabled={state.busy}
                          onClick={async () => { if (window.confirm('Replay this stored webhook event?') && await succeeded(run(() => adminApi.providers.replayWebhook(e.id)))) reload(); }}>
                          Replay
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={9} className="data-table__empty">{statusF ? 'No webhook events match this filter.' : 'No webhook events received yet.'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {detail && (
        <WebhookDrawer id={detail.id} fallback={detail} onClose={() => setDetail(null)}
          onReplay={canReplay && ['PENDING', 'FAILED', 'IGNORED'].includes(detail.processing_status)
            ? async () => {
              // Closed either way: on failure the page's error alert (behind the drawer) must be visible.
              const ok = await succeeded(run(() => adminApi.providers.replayWebhook(detail.id)));
              setDetail(null);
              if (ok) reload();
            }
            : null}
          replaying={state.busy}
        />
      )}
    </>
  );
}

function WebhookDrawer({ id, fallback, onClose, onReplay, replaying }) {
  const { status, data } = useApiResource(() => adminApi.providers.webhook(id).catch(() => fallback));
  const d = (status === 'ready' && data) ? data : fallback;
  return (
    <>
      <div className="pv-drawer-backdrop" onClick={onClose} />
      <aside className="pv-drawer" role="dialog" aria-label="Webhook event">
        <div className="pv-drawer__head">
          <h3 className="pv-drawer__title">{d.normalized_event_type || d.normalizedEventType || 'Webhook event'}</h3>
          <button type="button" className="pv-drawer__close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="pv-drawer__body">
          <div className="pv-drawer__section">
            <h4>Event</h4>
            <dl>
              <div className="pv-kv"><dt>Capability</dt><dd>{d.capability}</dd></div>
              <div className="pv-kv"><dt>Provider</dt><dd>{d.provider_key || d.providerKey}</dd></div>
              <div className="pv-kv"><dt>Received</dt><dd>{when(d.received_at || d.receivedAt)}</dd></div>
              <div className="pv-kv"><dt>Verification</dt><dd>{d.verification_status || d.verificationStatus}</dd></div>
              <div className="pv-kv"><dt>Processing</dt><dd>{d.processing_status || d.processingStatus}</dd></div>
              <div className="pv-kv"><dt>Attempts</dt><dd>{d.attempt_count ?? d.attemptCount ?? 0}</dd></div>
            </dl>
          </div>
          {(d.resource_type || d.resourceType) && (
            <div className="pv-drawer__section">
              <h4>Resource</h4>
              <dl>
                <div className="pv-kv"><dt>Type</dt><dd>{d.resource_type || d.resourceType}</dd></div>
                <div className="pv-kv"><dt>Id</dt><dd>{d.resource_id || d.resourceId}</dd></div>
              </dl>
            </div>
          )}
          {(d.last_error_code || d.lastErrorCode) && (
            <div className="pv-drawer__section">
              <h4>Last error</h4>
              <p className="pv-drawer__err">{d.last_error_code || d.lastErrorCode}</p>
            </div>
          )}
          {(d.safeSummary || d.safe_summary_json) && (
            <div className="pv-drawer__section">
              <h4>Safe summary</h4>
              <pre className="pv-drawer__err" style={{ background: 'var(--surface-muted, rgba(0,0,0,0.03))', color: 'var(--text)' }}>
                {JSON.stringify(d.safeSummary || d.safe_summary_json, null, 2)}
              </pre>
            </div>
          )}
        </div>
        {onReplay && (
          <div className="pv-drawer__actions">
            <Button busy={replaying} onClick={onReplay}>Replay event</Button>
            <Button variant="ghost" onClick={onClose}>Close</Button>
          </div>
        )}
      </aside>
    </>
  );
}

// ---------------------------------------------------------------------------
// OUTBOX
// ---------------------------------------------------------------------------
const OB_STATUS = {
  PENDING: ['neutral', 'Queued'],
  PROCESSING: ['processing', 'Processing'],
  FAILED: ['retrying', 'Retrying'],
  PROCESSED: ['ok', 'Delivered'],
  DEAD: ['bad', 'Failed'],
  RECONCILIATION_REQUIRED: ['bad', 'Needs reconciliation'],
  CANCELLED: ['muted', 'Cancelled'],
};
// UI filter value -> backend enum
const OB_FILTERS = [
  ['', 'All statuses'],
  ['PENDING', 'Queued'],
  ['PROCESSING', 'Processing'],
  ['FAILED', 'Retrying'],
  ['PROCESSED', 'Delivered'],
  ['DEAD', 'Failed'],
  ['RECONCILIATION_REQUIRED', 'Needs reconciliation'],
  ['CANCELLED', 'Cancelled'],
];
const RESOURCE_LABEL = {
  order: 'Order', shipment: 'Shipment', payment: 'Payment', return: 'Return',
  return_request: 'Return', customer: 'Customer', fulfillment: 'Fulfilment', notification: 'Notification',
};

function Outbox() {
  const { hasPermission } = useAuth();
  const canRetry = hasPermission('provider.operations.retry');
  const [statusF, setStatusF] = useState('');
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(0);
  return (
    <OutboxInner
      key={`${statusF}:${pageSize}:${page}`}
      statusF={statusF} pageSize={pageSize} page={page}
      setStatusF={(v) => { setStatusF(v); setPage(0); }}
      setPageSize={(v) => { setPageSize(v); setPage(0); }}
      setPage={setPage}
      canRetry={canRetry}
    />
  );
}

function OutboxInner({ statusF, pageSize, page, setStatusF, setPageSize, setPage, canRetry }) {
  const { status, data, reload } = useApiResource(
    () => adminApi.providers.outbox({ limit: pageSize, offset: page * pageSize, ...(statusF ? { status: statusF } : {}) }),
  );
  // separate, larger fetch purely for the "in view" metric strip (bounded at 200)
  const summary = useApiResource(() => adminApi.providers.outbox({ limit: 200 }));
  const [run, state] = useMutation((fn) => fn());
  const [detail, setDetail] = useState(null);

  const rows = data?.events ?? [];
  const all = summary.data?.events ?? [];
  const c = (fn) => all.filter(fn).length;
  const nextRetry = all
    .filter((o) => ['PENDING', 'FAILED'].includes(o.status) && o.next_attempt_at)
    .map((o) => o.next_attempt_at)
    .sort((a, b) => new Date(a) - new Date(b))[0];

  const canGoPrev = page > 0;
  const canGoNext = rows.length === pageSize;

  return (
    <>
      <Hero
        title="Outbox"
        text="Outbound provider events waiting to be delivered or retried. A business transaction and its side-effect event commit together; a worker delivers each with bounded backoff and a dead-letter state."
        bullets={['Outgoing event queue', 'Retry visibility', 'Failure monitoring']}
      />

      {summary.status === 'ready' && all.length > 0 && (
        <StatStrip
          min={150}
          cards={[
            { label: 'Queued', value: c((o) => o.status === 'PENDING') },
            { label: 'Processing', value: c((o) => o.status === 'PROCESSING') },
            { label: 'Retrying', value: c((o) => o.status === 'FAILED'), tone: c((o) => o.status === 'FAILED') ? 'warn' : undefined },
            { label: 'Failed', value: c((o) => ['DEAD', 'RECONCILIATION_REQUIRED'].includes(o.status)), tone: c((o) => ['DEAD', 'RECONCILIATION_REQUIRED'].includes(o.status)) ? 'danger' : undefined },
            { label: 'Next retry', value: nextRetry ? untilLabel(nextRetry) : '—' },
          ]}
        />
      )}

      <div className="wb-toolbar">
        <select className="wb-toolbar__search" style={{ flex: '0 1 200px' }} value={statusF} onChange={(e) => setStatusF(e.target.value)} aria-label="Status">
          {OB_FILTERS.map(([v, l]) => <option key={v || 'all'} value={v}>{l}</option>)}
        </select>
        <span className="wb-toolbar__spacer" />
        <Button variant="secondary" onClick={reload}>Refresh</Button>
      </div>
      {state.error && <InlineAlert tone="error">{state.error.message}</InlineAlert>}

      {status === 'loading' && <LoadingState label="Loading outbox…" />}
      {status === 'error' && <ErrorState message="Couldn’t load outbox events." onRetry={reload} />}
      {status === 'ready' && rows.length === 0 && (
        <div className="wb-empty">
          <span className="wb-empty__icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 7l8 5 8-5M4 7v10l8 5 8-5V7M4 7l8-5 8 5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </span>
          <p className="wb-empty__title">{statusF ? 'No events match this filter' : 'Outbox is clear'}</p>
          <p className="wb-empty__body">
            {statusF
              ? 'Try a different status, or clear the filter to see all outbound events.'
              : 'There are no outbound provider events waiting or retrying right now.'}
          </p>
          {statusF && <div className="wb-empty__actions"><Button variant="ghost" onClick={() => setStatusF('')}>Clear filter</Button></div>}
        </div>
      )}
      {status === 'ready' && rows.length > 0 && (
        <>
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr>
                <th>Created</th><th>Event</th><th>Resource</th><th>Status</th>
                <th>Attempts</th><th>Next retry</th><th>Last error</th><th />
              </tr></thead>
              <tbody>
                {rows.map((o) => {
                  const [tone, label] = OB_STATUS[o.status] || ['muted', o.status];
                  const retryable = canRetry && ['PENDING', 'PROCESSING', 'FAILED', 'DEAD'].includes(o.status);
                  const cancellable = canRetry && ['PENDING', 'FAILED', 'PROCESSING'].includes(o.status);
                  return (
                    <tr key={o.id}>
                      <td className="pv-time" title={when(o.created_at)}>{rel(o.created_at)}</td>
                      <td>
                        <div className="pv-stack">
                          <span className="pv-stack__main">{o.event_type}</span>
                          {o.aggregate_type && <span className="pv-stack__sub">{o.aggregate_type}</span>}
                        </div>
                      </td>
                      <td>
                        {o.aggregate_id
                          ? <div className="pv-stack"><span className="pv-stack__main">{RESOURCE_LABEL[o.aggregate_type] || 'Resource'}</span><span className="pv-stack__sub">{shortId(o.aggregate_id)}</span></div>
                          : '—'}
                      </td>
                      <td><Badge tone={tone}>{label}</Badge></td>
                      <td>{o.attempt_count} of {o.max_attempts}</td>
                      <td className="pv-time" title={o.next_attempt_at ? when(o.next_attempt_at) : ''}>
                        {['PENDING', 'FAILED'].includes(o.status) ? untilLabel(o.next_attempt_at) : '—'}
                      </td>
                      <td>{o.last_error_code ? <span className="pv-err" title={o.last_error_code}>{o.last_error_code}</span> : '—'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button type="button" className="linkish" onClick={() => setDetail(o)}>Details</button>
                        {retryable && (
                          <button type="button" className="linkish" style={{ marginLeft: 8 }} disabled={state.busy}
                            onClick={async () => { if (await succeeded(run(() => adminApi.providers.retryOutbox(o.id)))) { reload(); summary.reload(); } }}>
                            Retry now
                          </button>
                        )}
                        {cancellable && (
                          <button type="button" className="linkish linkish--danger" style={{ marginLeft: 8 }} disabled={state.busy}
                            onClick={async () => { if (window.confirm('Cancel this outbound event? It will not be delivered.') && await succeeded(run(() => adminApi.providers.cancelOutbox(o.id)))) { reload(); summary.reload(); } }}>
                            Cancel
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="pv-footer">
            <span>Showing {page * pageSize + 1}–{page * pageSize + rows.length}</span>
            <div className="pv-footer__pager">
              <label>Rows
                <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} style={{ marginLeft: 6 }}>
                  {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <Button variant="secondary" disabled={!canGoPrev} onClick={() => setPage(page - 1)}>Previous</Button>
              <Button variant="secondary" disabled={!canGoNext} onClick={() => setPage(page + 1)}>Next</Button>
            </div>
          </div>
        </>
      )}

      {detail && (
        <>
          <div className="pv-drawer-backdrop" onClick={() => setDetail(null)} />
          <aside className="pv-drawer" role="dialog" aria-label="Outbox event">
            <div className="pv-drawer__head">
              <div>
                <h3 className="pv-drawer__title">{detail.event_type}</h3>
                <Badge tone={(OB_STATUS[detail.status] || ['muted'])[0]}>{(OB_STATUS[detail.status] || ['', detail.status])[1]}</Badge>
              </div>
              <button type="button" className="pv-drawer__close" onClick={() => setDetail(null)} aria-label="Close">×</button>
            </div>
            <div className="pv-drawer__body">
              <div className="pv-drawer__section">
                <h4>Event</h4>
                <dl>
                  <div className="pv-kv"><dt>Event type</dt><dd>{detail.event_type}</dd></div>
                  <div className="pv-kv"><dt>Status</dt><dd>{detail.status}</dd></div>
                  <div className="pv-kv"><dt>Outcome class</dt><dd>{detail.outcome_class || '—'}</dd></div>
                  <div className="pv-kv"><dt>Created</dt><dd>{when(detail.created_at)}</dd></div>
                  {detail.processed_at && <div className="pv-kv"><dt>Settled</dt><dd>{when(detail.processed_at)}</dd></div>}
                </dl>
              </div>
              <div className="pv-drawer__section">
                <h4>Resource</h4>
                <dl>
                  <div className="pv-kv"><dt>Type</dt><dd>{RESOURCE_LABEL[detail.aggregate_type] || detail.aggregate_type || '—'}</dd></div>
                  <div className="pv-kv"><dt>Id</dt><dd>{detail.aggregate_id || '—'}</dd></div>
                </dl>
              </div>
              <div className="pv-drawer__section">
                <h4>Delivery</h4>
                <dl>
                  <div className="pv-kv"><dt>Attempts</dt><dd>{detail.attempt_count} of {detail.max_attempts}</dd></div>
                  <div className="pv-kv"><dt>Next retry</dt><dd>{detail.next_attempt_at ? when(detail.next_attempt_at) : '—'}</dd></div>
                </dl>
              </div>
              {detail.last_error_code && (
                <div className="pv-drawer__section">
                  <h4>Last error</h4>
                  <p className="pv-drawer__err">{detail.last_error_code}</p>
                  {detail.status === 'RECONCILIATION_REQUIRED' && (
                    <InlineAlert tone="warning">Unknown provider outcome — resolve this through Reconciliation, not a blind retry.</InlineAlert>
                  )}
                </div>
              )}
            </div>
            {canRetry && (
              <div className="pv-drawer__actions">
                {['PENDING', 'PROCESSING', 'FAILED', 'DEAD'].includes(detail.status) && (
                  <Button busy={state.busy} onClick={async () => { const ok = await succeeded(run(() => adminApi.providers.retryOutbox(detail.id))); setDetail(null); if (ok) { reload(); summary.reload(); } }}>Retry now</Button>
                )}
                {['PENDING', 'PROCESSING', 'FAILED'].includes(detail.status) && (
                  <Button variant="ghost" busy={state.busy} onClick={async () => { const ok = await succeeded(run(() => adminApi.providers.cancelOutbox(detail.id))); setDetail(null); if (ok) { reload(); summary.reload(); } }}>Cancel</Button>
                )}
              </div>
            )}
          </aside>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// ATTEMPTS
// ---------------------------------------------------------------------------
function Attempts() {
  const [capF, setCapF] = useState('');
  const [outcomeF, setOutcomeF] = useState('');
  return <AttemptsInner key={`${capF}:${outcomeF}`} capF={capF} outcomeF={outcomeF} setCapF={setCapF} setOutcomeF={setOutcomeF} />;
}
function AttemptsInner({ capF, outcomeF, setCapF, setOutcomeF }) {
  const { status, data, error, reload } = useApiResource(
    () => adminApi.providers.attempts({ limit: 150, ...(capF ? { capability: capF } : {}), ...(outcomeF ? { outcome: outcomeF } : {}) }),
  );
  const rows = data?.attempts ?? [];
  const capabilities = [...new Set(rows.map((r) => r.capability))].sort();
  const c = (o) => rows.filter((r) => r.outcome === o).length;

  return (
    <>
      <Hero
        title="Provider attempts"
        text="Every individual call to an external provider — the deep operational log behind the outbox and webhook activity. Read-only."
        bullets={['One row per provider call', 'Outcome + normalized error', 'Latency + correlation id']}
      />
      {status === 'ready' && rows.length > 0 && (
        <StatStrip
          min={150}
          cards={[
            { label: 'In view', value: rows.length, hint: 'most recent 150' },
            { label: 'Success', value: c('SUCCESS'), tone: 'ok' },
            { label: 'Failure', value: c('FAILURE'), tone: c('FAILURE') ? 'warn' : undefined },
            { label: 'Unknown', value: c('UNKNOWN') || c('AMBIGUOUS'), tone: (c('UNKNOWN') || c('AMBIGUOUS')) ? 'danger' : undefined },
          ]}
        />
      )}
      <div className="wb-toolbar">
        <select className="wb-toolbar__search" style={{ flex: '0 1 170px' }} value={capF} onChange={(e) => setCapF(e.target.value)} aria-label="Capability">
          <option value="">All capabilities</option>
          {capabilities.map((cc) => <option key={cc} value={cc}>{cc}</option>)}
        </select>
        <select className="wb-toolbar__search" style={{ flex: '0 1 150px' }} value={outcomeF} onChange={(e) => setOutcomeF(e.target.value)} aria-label="Outcome">
          <option value="">All outcomes</option>
          <option value="SUCCESS">Success</option>
          <option value="FAILURE">Failure</option>
          <option value="UNKNOWN">Unknown</option>
        </select>
        <span className="wb-toolbar__spacer" />
        <Button variant="secondary" onClick={reload}>Refresh</Button>
      </div>

      {status === 'loading' && <LoadingState label="Loading provider attempts…" />}
      {status === 'error' && <ErrorState message={error?.message} onRetry={reload} />}
      {status === 'ready' && (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Started</th><th>Capability / Provider</th><th>Operation</th><th>Outcome</th><th>Error</th><th>Latency</th><th>Correlation</th></tr></thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td className="pv-time" title={when(a.started_at)}>{rel(a.started_at)}</td>
                  <td><div className="pv-stack"><span className="pv-stack__main">{a.capability}</span><span className="pv-stack__sub">{a.provider_key}</span></div></td>
                  <td>{a.operation}</td>
                  <td><Badge tone={a.outcome === 'SUCCESS' ? 'ok' : a.outcome === 'FAILURE' ? 'bad' : 'retrying'}>{a.outcome}</Badge></td>
                  <td>{a.normalized_error_code ? <span className="pv-err" title={a.normalized_error_code}>{a.normalized_error_code}</span> : '—'}</td>
                  <td>{a.duration_ms != null ? `${a.duration_ms} ms` : '—'}</td>
                  <td className="pv-stack__sub">{a.correlation_id}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={7} className="data-table__empty">No provider attempts match these filters.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// SHIPPING PRICING
// ---------------------------------------------------------------------------
const SURFACE_OPTS = [
  ['ZERO', 'Free', 'Customer pays ₹0 — the business absorbs the carrier cost.'],
  ['PROVIDER_RATE', 'Provider rate', 'Customer pays exactly what the carrier charges.'],
  ['FLAT', 'Flat rate', 'Customer pays a fixed amount you set.'],
];

function ShippingPricing() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('settings.manage');
  const { status, data, reload } = useApiResource(() => adminApi.shipping.getPricingPolicy());
  const [save, saveState] = useMutation((body) => adminApi.shipping.updatePricingPolicy(body));
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState(false);

  if (status === 'loading') return <LoadingState label="Loading shipping pricing…" />;
  if (status === 'error') return <ErrorState message="Couldn’t load shipping pricing settings." onRetry={reload} />;

  const p = form || data;
  const dirty = Boolean(form) && JSON.stringify(form) !== JSON.stringify(data);
  const set = (k, v) => { setSaved(false); setForm({ ...p, [k]: v }); };
  const setMinor = (k, rupeeStr) => set(k, Math.round(Number(rupeeStr || 0) * 100));
  const flatInvalid = p.surfaceCustomerChargeMode === 'FLAT' && (!(p.surfaceFlatChargeMinor >= 0) || Number.isNaN(p.surfaceFlatChargeMinor));
  const surchargeInvalid = !(p.expressAdditionalChargeMinor >= 0) || Number.isNaN(p.expressAdditionalChargeMinor);

  const doSave = async () => {
    await save(form);
    setForm(null);
    setSaved(true);
    reload();
  };

  const surfaceCustomerText = p.surfaceCustomerChargeMode === 'ZERO'
    ? '₹0 (business absorbs carrier cost)'
    : p.surfaceCustomerChargeMode === 'PROVIDER_RATE'
      ? 'Real provider rate'
      : `₹${rupees(p.surfaceFlatChargeMinor)} flat`;

  return (
    <>
      <Hero
        title="Shipping pricing"
        text="Control what customers pay for Surface and Express shipping while keeping the real carrier cost tracked separately per shipment."
        bullets={['Customer charge ≠ actual logistics cost', 'Surface and Express priced independently']}
      />

      <div className="pv-shipping">
        <div>
          <div className="pv-card">
            <h3 className="pv-card__title">Surface shipping</h3>
            <p className="pv-card__desc">Choose how much the customer pays for standard Surface delivery.</p>
            <span className="pv-card__label">Customer charge mode</span>
            <div className="pv-segment" role="radiogroup" aria-label="Surface customer charge mode">
              {SURFACE_OPTS.map(([value, name, hint]) => (
                <label key={value} className={`pv-segment__opt${p.surfaceCustomerChargeMode === value ? ' pv-segment__opt--on' : ''}`}>
                  <input type="radio" name="surface-mode" value={value} checked={p.surfaceCustomerChargeMode === value}
                    disabled={!canManage} onChange={() => set('surfaceCustomerChargeMode', value)} />
                  <span className="pv-segment__name">{name}</span>
                  <span className="pv-segment__hint">{hint}</span>
                </label>
              ))}
            </div>
            {p.surfaceCustomerChargeMode === 'FLAT' && (
              <div className="pv-money-field">
                <label htmlFor="pv-flat">Flat shipping charge</label>
                <span className={`pv-money-input${flatInvalid ? ' pv-money-input--err' : ''}`}>
                  <span>₹</span>
                  <input id="pv-flat" type="number" min="0" step="0.01" disabled={!canManage}
                    value={rupees(p.surfaceFlatChargeMinor)} onChange={(e) => setMinor('surfaceFlatChargeMinor', e.target.value)} />
                </span>
              </div>
            )}
            {flatInvalid && <p className="pv-hero__text" style={{ color: '#dc2626' }}>Enter a valid non-negative amount.</p>}
          </div>

          <div className="pv-card">
            <h3 className="pv-card__title">Express shipping</h3>
            <p className="pv-card__desc">Express uses the real provider rate plus an optional CORCOTTON surcharge.</p>
            <div className="pv-readonly">
              <span>Provider rate</span>
              <strong>Calculated per shipment by the logistics provider</strong>
            </div>
            <div className="pv-money-field" style={{ marginTop: 0 }}>
              <label htmlFor="pv-surcharge">Additional surcharge</label>
              <span className={`pv-money-input${surchargeInvalid ? ' pv-money-input--err' : ''}`}>
                <span>₹</span>
                <input id="pv-surcharge" type="number" min="0" step="0.01" disabled={!canManage}
                  value={rupees(p.expressAdditionalChargeMinor)} onChange={(e) => setMinor('expressAdditionalChargeMinor', e.target.value)} />
              </span>
            </div>
            {surchargeInvalid && <p className="pv-hero__text" style={{ color: '#dc2626' }}>Enter a valid non-negative amount.</p>}
            <div className="pv-formula">
              <span>Customer Express price</span><span className="pv-op">=</span>
              <code>provider rate</code><span className="pv-op">+</span>
              <code>₹{rupees(p.expressAdditionalChargeMinor)}</code>
            </div>
          </div>
        </div>

        <div>
          <div className="pv-card">
            <h3 className="pv-card__title">Current policy</h3>
            <dl>
              <div className="pv-preview__row"><dt>Surface — customer pays</dt><dd>{surfaceCustomerText}</dd></div>
              <div className="pv-preview__row"><dt>Surface — business absorbs</dt><dd>Carrier cost</dd></div>
              <div className="pv-preview__row"><dt>Express — customer pays</dt><dd>Rate + ₹{rupees(p.expressAdditionalChargeMinor)}</dd></div>
              <div className="pv-preview__row"><dt>Actual logistics cost</dt><dd>Tracked per shipment</dd></div>
            </dl>
          </div>

          <div className="pv-note">
            <span aria-hidden="true">⚠</span>
            <span>
              <strong>Actual logistics cost</strong>
              The amount paid to the carrier is recorded per shipment and is never shown to the customer as the shipping price
              unless Surface mode is set to “Provider rate”.
            </span>
          </div>

          <div className="pv-savebar" style={{ marginTop: 'var(--space-4)' }}>
            {dirty
              ? <span className="pv-savebar__status pv-savebar__status--dirty">Unsaved changes</span>
              : saved
                ? <span className="pv-savebar__status pv-savebar__status--saved">Saved</span>
                : <span className="pv-savebar__status" style={{ color: 'var(--text-muted)' }}>All changes saved</span>}
            <span className="pv-savebar__spacer" />
            {dirty && <Button variant="secondary" onClick={() => { setForm(null); setSaved(false); }}>Discard</Button>}
            {canManage && (
              <Button busy={saveState.busy} disabled={!dirty || flatInvalid || surchargeInvalid} onClick={doSave}>
                Save shipping pricing
              </Button>
            )}
          </div>
          {saveState.error && <InlineAlert tone="error">{saveState.error.message}</InlineAlert>}
          {!canManage && <p className="pv-hero__text" style={{ marginTop: 8 }}>You have read-only access to shipping pricing.</p>}
        </div>
      </div>

      <OwnerDelivery canManage={canManage} />
    </>
  );
}

// ---------------------------------------------------------------------------
// OWNER DELIVERY
// ---------------------------------------------------------------------------
const NEW_ZONE = { name: '', pincode: '', notes: '', charge: '', enabled: true };

function OwnerDelivery({ canManage }) {
  const { status, data, error, reload } = useApiResource(() => adminApi.shipping.ownerDelivery());
  const [act, actState] = useMutation((fn) => fn());
  const [draft, setDraft] = useState(NEW_ZONE);
  const [rowErr, setRowErr] = useState('');

  if (status === 'loading') return <div className="pv-card" style={{ marginTop: 'var(--space-4)' }}><LoadingState label="Loading Owner Delivery…" /></div>;
  if (status === 'error') return <div className="pv-card" style={{ marginTop: 'var(--space-4)' }}><ErrorState message={error?.message} onRetry={reload} /></div>;

  const enabled = data?.settings?.ownerDeliveryEnabled;
  const zones = data?.zones ?? [];

  const run = async (fn) => {
    setRowErr('');
    try { await act(fn); reload(); return true; }
    catch (e) { setRowErr(e?.message || 'Something went wrong.'); return false; }
  };
  const addZone = async () => {
    const chargeMinor = Math.round(Number(draft.charge || 0) * 100);
    if (!draft.name.trim() || !/^\d{6}$/.test(draft.pincode.trim())) { setRowErr('A name and a valid 6-digit PIN are required.'); return; }
    // The typed zone is kept when the save is refused, so it can be corrected.
    if (await run(() => adminApi.shipping.createOwnerDeliveryZone({ name: draft.name.trim(), pincode: draft.pincode.trim(), notes: draft.notes.trim() || null, chargeMinor, enabled: draft.enabled }))) setDraft(NEW_ZONE);
  };

  return (
    <div className="pv-card" style={{ marginTop: 'var(--space-4)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <h3 className="pv-card__title">Owner Delivery</h3>
          <p className="pv-card__desc">
            A CORCOTTON-operated delivery option offered at checkout when the customer’s PIN matches an enabled zone below.
            It is never booked with a carrier — you deliver it and the order stays in the manual queue.
          </p>
        </div>
        <label className="pv-switch" title={canManage ? 'Enable Owner Delivery globally' : 'Requires settings.manage'}>
          <input type="checkbox" checked={Boolean(enabled)} disabled={!canManage || actState.busy}
            onChange={() => run(() => adminApi.shipping.setOwnerDeliveryEnabled(!enabled))} aria-label="Owner Delivery enabled" />
          <span className="pv-switch__track" />
        </label>
      </div>
      {!enabled && <InlineAlert tone="info">Owner Delivery is off. Zones below are saved but won’t appear at checkout until you turn it on.</InlineAlert>}
      {rowErr && <InlineAlert tone="error">{rowErr}</InlineAlert>}

      <div className="table-wrap" style={{ marginTop: 12 }}>
        <table className="data-table">
          <thead><tr><th>Area / zone</th><th>PIN code</th><th>Address / notes</th><th>Delivery charge</th><th>Active</th><th /></tr></thead>
          <tbody>
            {zones.map((z) => (
              <tr key={z.id}>
                <td><ZoneName zone={z} canManage={canManage} onSave={(name) => run(() => adminApi.shipping.updateOwnerDeliveryZone(z.id, { name }))} /></td>
                <td><code>{z.pincode}</code></td>
                <td><ZoneNotes zone={z} canManage={canManage} onSave={(notes) => run(() => adminApi.shipping.updateOwnerDeliveryZone(z.id, { notes }))} /></td>
                <td><ZoneCharge zone={z} canManage={canManage} onSave={(chargeMinor) => run(() => adminApi.shipping.updateOwnerDeliveryZone(z.id, { chargeMinor }))} /></td>
                <td>
                  <label className="pv-switch">
                    <input type="checkbox" checked={z.enabled} disabled={!canManage || actState.busy}
                      onChange={() => run(() => adminApi.shipping.updateOwnerDeliveryZone(z.id, { enabled: !z.enabled }))} aria-label={`${z.pincode} active`} />
                    <span className="pv-switch__track" />
                  </label>
                </td>
                <td>{canManage && (
                  <button type="button" className="linkish linkish--danger" disabled={actState.busy}
                    onClick={() => { if (window.confirm(`Remove Owner Delivery for PIN ${z.pincode}?`)) run(() => adminApi.shipping.deleteOwnerDeliveryZone(z.id)); }}>
                    Remove
                  </button>
                )}</td>
              </tr>
            ))}
            {zones.length === 0 && <tr><td colSpan={6} className="data-table__empty">No Owner Delivery zones yet.</td></tr>}
            {canManage && (
              <tr>
                <td><input className="wb-toolbar__search" placeholder="e.g. South Delhi" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></td>
                <td><input className="wb-toolbar__search" placeholder="110001" maxLength={6} value={draft.pincode} onChange={(e) => setDraft({ ...draft, pincode: e.target.value.replace(/\D/g, '').slice(0, 6) })} /></td>
                <td><input className="wb-toolbar__search" placeholder="Landmark or delivery note" maxLength={255} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} /></td>
                <td>
                  <span className="pv-money-input" style={{ maxWidth: 130 }}>
                    <span>₹</span>
                    <input type="number" min="0" step="1" placeholder="0" value={draft.charge} onChange={(e) => setDraft({ ...draft, charge: e.target.value })} />
                  </span>
                </td>
                <td>
                  <label className="pv-switch">
                    <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} aria-label="New zone active" />
                    <span className="pv-switch__track" />
                  </label>
                </td>
                <td><Button variant="soft" busy={actState.busy} onClick={addZone}>Add zone</Button></td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ZoneName({ zone, canManage, onSave }) {
  const [v, setV] = useState(zone.name);
  if (!canManage) return <span>{zone.name}</span>;
  return (
    <input className="wb-toolbar__search" value={v} onChange={(e) => setV(e.target.value)}
      onBlur={() => { if (v.trim() && v !== zone.name) onSave(v.trim()); else setV(zone.name); }} />
  );
}
// Free-text address / landmark for the zone. Optional by design — the customer
// still supplies the delivery address; this is the founder's own note about
// what the zone covers.
function ZoneNotes({ zone, canManage, onSave }) {
  const [v, setV] = useState(zone.notes || '');
  if (!canManage) return <span className="text-faint">{zone.notes || '—'}</span>;
  return (
    <input className="wb-toolbar__search" placeholder="Landmark or delivery note" maxLength={255} value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { const next = v.trim(); if (next !== (zone.notes || '')) onSave(next || null); }} />
  );
}

function ZoneCharge({ zone, canManage, onSave }) {
  const [v, setV] = useState((zone.chargeMinor / 100).toString());
  if (!canManage) return <span>₹{(zone.chargeMinor / 100).toLocaleString('en-IN')}</span>;
  return (
    <span className="pv-money-input" style={{ maxWidth: 130 }}>
      <span>₹</span>
      <input type="number" min="0" step="1" value={v} onChange={(e) => setV(e.target.value)}
        onBlur={() => { const m = Math.round(Number(v || 0) * 100); if (m !== zone.chargeMinor && m >= 0) onSave(m); else setV((zone.chargeMinor / 100).toString()); }} />
    </span>
  );
}

// ---------------------------------------------------------------------------
export function ProvidersPage() {
  // ?tab=Instagram opens a tab directly (the homepage builder links there).
  const [tab, setTab] = useState(() => {
    const wanted = new URLSearchParams(window.location.search).get('tab');
    return TABS.includes(wanted) ? wanted : 'Overview';
  });
  return (
    <PageShell
      title="Providers"
      description="Monitor provider configuration, health, inbound webhooks and outbound delivery activity. Provider secrets and endpoints live in the backend environment; the one exception is the Instagram access token, pasted once under Instagram and stored encrypted."
    >
      <nav className="pv-tabs" aria-label="Providers sections">
        {TABS.map((t) => (
          <button key={t} type="button" className={`pv-tab${tab === t ? ' pv-tab--active' : ''}`} aria-current={tab === t ? 'page' : undefined} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>

      {tab === 'Overview' && <Overview />}
      {tab === 'Instagram' && <InstagramTab />}
      {tab === 'Webhooks' && <Webhooks />}
      {tab === 'Outbox' && <Outbox />}
      {tab === 'Attempts' && <Attempts />}
      {tab === 'Shipping pricing' && <ShippingPricing />}
    </PageShell>
  );
}

export default ProvidersPage;
