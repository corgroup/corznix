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

const when = (d) => (d ? new Date(d).toLocaleString() : '—');
const STATUSES = ['IN_PROGRESS', 'WAITING_CUSTOMER', 'WAITING_INTERNAL', 'RESOLVED', 'CLOSED'];
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

export function SupportDetailPage() {
  const { id } = useParams();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('support.manage');
  const staff = useApiResource(() => adminApi.listStaff());
  const { status, data: t, error, reload } = useApiResource(() => adminApi.support.get(id));
  const [reply, setReply] = useState('');
  const [visibility, setVisibility] = useState('CUSTOMER');

  const [act, actState] = useMutation((fn) => fn());
  const run = (fn) => async () => { try { await act(fn); } finally { reload(); } };

  if (status === 'loading') return <PageShell title="Ticket"><LoadingState label="Loading ticket…" /></PageShell>;
  if (status === 'error') return <PageShell title="Ticket"><ErrorState message={error?.message} onRetry={reload} /></PageShell>;

  const staffList = staff.data?.staff ?? [];

  return (
    <PageShell title={t.ticketNumber} description={`${t.category} · ${t.subject}`}>
      <p>
        <span className={`pill pill--${['RESOLVED', 'CLOSED'].includes(t.status) ? 'good' : 'warn'}`}>{t.status.replaceAll('_', ' ')}</span>
        {'  '}priority {t.priority}
        {t.orderId ? <> · <Link to={`/orders/${t.orderId}`}>linked order</Link></> : null}
        {t.returnRequestId ? <> · <Link to={`/returns/${t.returnRequestId}`}>linked return</Link></> : null}
      </p>
      {actState.error && <InlineAlert tone="error">{actState.error.message}</InlineAlert>}
      <InlineAlert tone="info">Refunds and order changes are not done here — use the Orders / Returns screens.</InlineAlert>

      {canManage && (
        <div className="editor-actions" style={{ marginBottom: 20, flexWrap: 'wrap' }}>
          <select className="form-field__input" style={{ maxWidth: 220 }} value={t.assignedStaffId || ''}
            onChange={(e) => run(() => adminApi.support.assign(id, e.target.value || null, t.assignmentVersion))()}>
            <option value="">Unassigned</option>
            {staffList.map((s) => <option key={s.id} value={s.id}>{s.email}</option>)}
          </select>
          <select className="form-field__input" style={{ maxWidth: 150 }} value={t.priority}
            onChange={(e) => run(() => adminApi.support.priority(id, e.target.value))()}>
            {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <select className="form-field__input" style={{ maxWidth: 200 }} value={t.status}
            onChange={(e) => run(() => adminApi.support.status(id, e.target.value))()}>
            <option value={t.status}>{t.status.replaceAll('_', ' ')}</option>
            {STATUSES.filter((s) => s !== t.status).map((s) => <option key={s} value={s}>{s.replaceAll('_', ' ')}</option>)}
          </select>
        </div>
      )}

      <h3>Conversation</h3>
      {t.messages.map((m, i) => (
        <div key={i} style={{ margin: '8px 0', padding: 10, borderLeft: `3px solid ${m.visibility === 'INTERNAL' ? '#c96' : '#69c'}` }}>
          <strong>{m.authorType}{m.visibility === 'INTERNAL' ? ' · INTERNAL NOTE' : ''}</strong> <span style={{ opacity: 0.6 }}>{when(m.at)}</span>
          <p style={{ margin: '4px 0 0' }}>{m.body}</p>
        </div>
      ))}

      {canManage && (
        <div style={{ marginTop: 16 }}>
          <textarea className="form-field__input" rows={3} style={{ width: '100%' }} placeholder="Reply…" value={reply} onChange={(e) => setReply(e.target.value)} />
          <div className="editor-actions" style={{ marginTop: 8 }}>
            <select className="form-field__input" style={{ maxWidth: 200 }} value={visibility} onChange={(e) => setVisibility(e.target.value)}>
              <option value="CUSTOMER">Visible to customer</option>
              <option value="INTERNAL">Internal note</option>
            </select>
            <Button busy={actState.busy} disabled={!reply.trim()} onClick={async () => { await act(() => adminApi.support.reply(id, reply, visibility)); setReply(''); reload(); }}>Send</Button>
          </div>
        </div>
      )}

      <h3>Activity</h3>
      <ul>
        {t.events.map((e, i) => <li key={i}>{when(e.at)} — {e.eventType}{e.toStatus ? ` → ${e.toStatus}` : ''} ({e.actorType})</li>)}
      </ul>
    </PageShell>
  );
}

export default SupportDetailPage;
