import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageShell } from '../layout/PageShell.jsx';
import { LoadingState } from '../components/feedback/LoadingState.jsx';
import { ErrorState } from '../components/feedback/ErrorState.jsx';
import { adminApi } from '../api/adminApi.js';
import { useApiResource } from '../hooks/useApiResource.js';

const STATUSES = ['', 'PENDING', 'PUBLISHED', 'REJECTED', 'HIDDEN'];
const tone = (s) => (s === 'PUBLISHED' ? 'good' : s === 'PENDING' ? 'warn' : 'muted');
const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);

export function ReviewsPage() {
  const [status, setStatus] = useState('PENDING');
  const filters = status ? { status } : {};
  const { status: load, data, error, reload } = useApiResource(() => adminApi.reviews.list(filters));
  const rows = data?.reviews ?? [];

  return (
    <PageShell
      title="Product Reviews"
      description="Moderation moves a review's status only — it never edits the customer's words."
      actions={
        <select value={status} onChange={(e) => { setStatus(e.target.value); reload(); }} className="form-field__input" style={{ maxWidth: 200 }}>
          {STATUSES.map((s) => <option key={s} value={s}>{s || 'All statuses'}</option>)}
        </select>
      }
    >
      {load === 'loading' && <LoadingState label="Loading reviews…" />}
      {load === 'error' && <ErrorState message={error?.message} onRetry={reload} />}
      {load === 'ready' && (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Product</th><th>Rating</th><th>Title</th><th>Excerpt</th><th>Verified</th><th>Status</th><th>Submitted</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><Link to={`/reviews/${r.id}`}>{r.productName || r.productId}</Link></td>
                  <td title={`${r.rating}/5`}>{stars(r.rating)}</td>
                  <td>{r.title || '—'}</td>
                  <td style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.body}</td>
                  <td>{r.verifiedPurchase ? '✔' : '—'}</td>
                  <td><span className={`pill pill--${tone(r.status)}`}>{r.status}</span></td>
                  <td>{new Date(r.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={7} className="data-table__empty">No reviews.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </PageShell>
  );
}

export default ReviewsPage;
