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

const tone = (s) => (s === 'ACTIVE' ? 'good' : s === 'DRAFT' ? 'muted' : 'warn');
const summarize = (p) => (p.discountType === 'PERCENTAGE'
  ? `${(p.discountValue / 100).toFixed(p.discountValue % 100 ? 2 : 0)}%${p.maxDiscountMinor ? ` (max ₹${p.maxDiscountMinor / 100})` : ''}`
  : `₹${(p.discountValue / 100).toFixed(2)}`);

export function PromotionsPage() {
  const nav = useNavigate();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('promotions.manage');
  const [status, setStatus] = useState('');
  const { status: load, data, error, reload } = useApiResource(() => adminApi.promotions.list(status ? { status } : {}));
  const rows = data?.promotions ?? [];
  const [name, setName] = useState('');
  const [create, createState] = useMutation(() => adminApi.promotions.create({
    name: name.trim(), discountType: 'PERCENTAGE', discountScope: 'ORDER', discountValue: 1000, triggerType: 'CODE_REQUIRED',
  }));

  return (
    <PageShell
      title="Promotions & Coupons"
      description="Backend-authoritative pricing rules. Discounts are computed by the server — staff configure the rule, never a per-order amount."
      actions={
        <select value={status} onChange={(e) => { setStatus(e.target.value); reload(); }} className="form-field__input" style={{ maxWidth: 180 }}>
          {['', 'DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED'].map((s) => <option key={s} value={s}>{s || 'All statuses'}</option>)}
        </select>
      }
    >
      {canManage && (
        <div className="editor-actions" style={{ marginBottom: 20 }}>
          <input className="form-field__input" style={{ maxWidth: 320 }} placeholder="New promotion name" value={name} onChange={(e) => setName(e.target.value)} />
          <Button busy={createState.busy} disabled={name.trim().length < 2}
            onClick={async () => { const p = await create(); setName(''); reload(); nav(`/promotions/${p.id}`); }}>Create draft</Button>
        </div>
      )}
      {createState.error && <InlineAlert tone="error">{createState.error.message}</InlineAlert>}

      {load === 'loading' && <LoadingState label="Loading promotions…" />}
      {load === 'error' && <ErrorState message={error?.message} onRetry={reload} />}
      {load === 'ready' && (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Name</th><th>Discount</th><th>Trigger</th><th>Coupons</th><th>Redeemed</th><th>Priority</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td><Link to={`/promotions/${p.id}`}>{p.name}</Link></td>
                  <td>{summarize(p)} · {p.discountScope}</td>
                  <td>{p.triggerType}</td>
                  <td>{p.couponCount ?? 0}</td>
                  <td>{p.redeemedCount}{p.usageLimitTotal ? ` / ${p.usageLimitTotal}` : ''}</td>
                  <td>{p.priority}{p.stackable ? ' · stack' : ''}</td>
                  <td><span className={`pill pill--${tone(p.status)}`}>{p.status}</span></td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={7} className="data-table__empty">No promotions.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </PageShell>
  );
}

export default PromotionsPage;
