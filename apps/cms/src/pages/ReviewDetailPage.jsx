import { useState } from 'react';
import { useParams } from 'react-router-dom';
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
const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);
// Only transitions the backend accepts for each current status.
const ACTIONS_FOR = {
  PENDING: ['PUBLISH', 'REJECT'],
  PUBLISHED: ['REJECT', 'HIDE'],
  REJECTED: ['PUBLISH'],
  HIDDEN: ['PUBLISH', 'REJECT'],
};

export function ReviewDetailPage() {
  const { id } = useParams();
  const { hasPermission } = useAuth();
  const canModerate = hasPermission('reviews.moderate');
  const { status, data: r, error, reload } = useApiResource(() => adminApi.reviews.get(id));
  const [reason, setReason] = useState('');
  const [act, actState] = useMutation((fn) => fn());

  if (status === 'loading') return <PageShell title="Review"><LoadingState label="Loading review…" /></PageShell>;
  if (status === 'error') return <PageShell title="Review"><ErrorState message={error?.message} onRetry={reload} /></PageShell>;

  const moderate = (action) => async () => {
    try { await act(() => adminApi.reviews.moderate(id, action, r.statusVersion, reason.trim() || undefined)); setReason(''); }
    finally { reload(); }
  };

  return (
    <PageShell title={`Review · ${stars(r.rating)}`} description={`Product ${r.productSnapshot?.productName || r.productId}`}>
      <p>
        <span className={`pill pill--${r.status === 'PUBLISHED' ? 'good' : r.status === 'PENDING' ? 'warn' : 'muted'}`}>{r.status}</span>
        {'  '}{r.verifiedPurchase ? 'verified purchase' : 'unverified'} · submitted {when(r.createdAt)}
        {r.publishedAt ? ` · published ${when(r.publishedAt)}` : ''}
      </p>
      {actState.error && <InlineAlert tone="error">{actState.error.message}</InlineAlert>}
      <InlineAlert tone="info">The customer&apos;s rating, title and text are immutable. Moderation only changes visibility.</InlineAlert>

      <h3>{r.title || '(no title)'}</h3>
      <blockquote style={{ borderLeft: '3px solid #69c', margin: '8px 0', padding: '4px 12px', whiteSpace: 'pre-wrap' }}>{r.body}</blockquote>
      {r.moderationReason && <p style={{ opacity: 0.7 }}>Last moderation reason: {r.moderationReason}</p>}

      {canModerate && (
        <div style={{ marginTop: 16 }}>
          <input className="form-field__input" style={{ width: '100%', maxWidth: 480 }} placeholder="Reason (optional, recorded on the event)"
            value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="editor-actions" style={{ marginTop: 8, gap: 8 }}>
            {(ACTIONS_FOR[r.status] ?? []).map((a) => (
              <Button key={a} busy={actState.busy} onClick={moderate(a)}>{a}</Button>
            ))}
          </div>
        </div>
      )}

      <h3>Activity</h3>
      <ul>
        {r.events.map((e, i) => (
          <li key={i}>{when(e.at)} — {e.eventType}{e.toStatus ? ` → ${e.toStatus}` : ''} ({e.actorType}){e.reason ? ` — ${e.reason}` : ''}</li>
        ))}
      </ul>
    </PageShell>
  );
}

export default ReviewDetailPage;
