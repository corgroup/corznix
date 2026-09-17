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

const Field = ({ label, children }) => (
  <label className="form-field promo-field">
    <span className="form-field__label">{label}</span>{children}
  </label>
);

// A checkbox reads as one line: box then label, the whole row clickable.
const CheckField = ({ label, children }) => (
  <label className="check-field">{children}<span>{label}</span></label>
);

const EDITABLE = ['status', 'triggerType', 'discountType', 'discountScope', 'discountValue', 'maxDiscountMinor',
  'minSubtotalMinor', 'minQuantity', 'usageLimitTotal', 'usageLimitPerCustomer', 'stackable', 'priority',
  'firstOrderOnly', 'restorePolicy', 'startsAt', 'endsAt'];

export function PromotionDetailPage() {
  const { id } = useParams();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('promotions.manage');
  const { status, data: p, error, reload } = useApiResource(() => adminApi.promotions.get(id));
  const [draft, setDraft] = useState(null);
  const [save, saveState] = useMutation((body) => adminApi.promotions.update(id, body));
  const [code, setCode] = useState('');
  const [addCoupon, couponState] = useMutation(() => adminApi.promotions.addCoupon(id, code.trim()));

  if (status === 'loading') return <PageShell title="Promotion"><LoadingState label="Loading…" /></PageShell>;
  if (status === 'error') return <PageShell title="Promotion"><ErrorState message={error?.message} onRetry={reload} /></PageShell>;

  const form = draft ?? Object.fromEntries(EDITABLE.map((k) => [k, p[k] ?? '']));
  const set = (k, v) => setDraft({ ...form, [k]: v });
  const num = (v) => (v === '' || v == null ? null : Number(v));
  const submit = async () => {
    await save({
      status: form.status, triggerType: form.triggerType, discountType: form.discountType, discountScope: form.discountScope,
      discountValue: Number(form.discountValue), maxDiscountMinor: num(form.maxDiscountMinor),
      minSubtotalMinor: Number(form.minSubtotalMinor || 0), minQuantity: Number(form.minQuantity || 0),
      usageLimitTotal: num(form.usageLimitTotal), usageLimitPerCustomer: Number(form.usageLimitPerCustomer || 1),
      stackable: Boolean(form.stackable), priority: Number(form.priority || 100), firstOrderOnly: Boolean(form.firstOrderOnly),
      restorePolicy: form.restorePolicy || 'CONFIG_REQUIRED',
      startsAt: form.startsAt || null, endsAt: form.endsAt || null,
    });
    setDraft(null);
    reload();
  };

  return (
    <PageShell title={p.name} description={`v${p.version} · redeemed ${p.redeemedCount}${p.usageLimitTotal ? ` / ${p.usageLimitTotal}` : ''}`}>
      <InlineAlert tone="info">
        The discount is computed by the pricing engine at checkout — {p.discountType === 'PERCENTAGE' ? 'basis points (1500 = 15%)' : 'minor units (₹1 = 100)'}. A rule change bumps the version; placed orders keep their frozen discount snapshot.
      </InlineAlert>
      {saveState.error && <InlineAlert tone="error">{saveState.error.message}</InlineAlert>}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, margin: '16px 0' }}>
        <Field label="Status"><select className="form-field__input" disabled={!canManage} value={form.status} onChange={(e) => set('status', e.target.value)}>{['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED'].map((s) => <option key={s}>{s}</option>)}</select></Field>
        <Field label="Trigger"><select className="form-field__input" disabled={!canManage} value={form.triggerType} onChange={(e) => set('triggerType', e.target.value)}><option>CODE_REQUIRED</option><option>AUTOMATIC</option></select></Field>
        <Field label="Discount type"><select className="form-field__input" disabled={!canManage} value={form.discountType} onChange={(e) => set('discountType', e.target.value)}><option>PERCENTAGE</option><option>FIXED_AMOUNT</option></select></Field>
        <Field label="Scope"><select className="form-field__input" disabled={!canManage} value={form.discountScope} onChange={(e) => set('discountScope', e.target.value)}><option>ORDER</option><option>ITEM</option></select></Field>
        <Field label={form.discountType === 'PERCENTAGE' ? 'Value (bps)' : 'Value (minor)'}><input className="form-field__input" type="number" disabled={!canManage} value={form.discountValue} onChange={(e) => set('discountValue', e.target.value)} /></Field>
        <Field label="Max discount (minor)"><input className="form-field__input" type="number" disabled={!canManage} value={form.maxDiscountMinor ?? ''} onChange={(e) => set('maxDiscountMinor', e.target.value)} /></Field>
        <Field label="Min subtotal (minor)"><input className="form-field__input" type="number" disabled={!canManage} value={form.minSubtotalMinor} onChange={(e) => set('minSubtotalMinor', e.target.value)} /></Field>
        <Field label="Min quantity"><input className="form-field__input" type="number" disabled={!canManage} value={form.minQuantity} onChange={(e) => set('minQuantity', e.target.value)} /></Field>
        <Field label="Global usage limit"><input className="form-field__input" type="number" disabled={!canManage} value={form.usageLimitTotal ?? ''} onChange={(e) => set('usageLimitTotal', e.target.value)} /></Field>
        <Field label="Per-customer limit"><input className="form-field__input" type="number" disabled={!canManage} value={form.usageLimitPerCustomer} onChange={(e) => set('usageLimitPerCustomer', e.target.value)} /></Field>
        <Field label="Priority (lower first)"><input className="form-field__input" type="number" disabled={!canManage} value={form.priority} onChange={(e) => set('priority', e.target.value)} /></Field>
        <CheckField label="Stackable"><input type="checkbox" disabled={!canManage} checked={Boolean(form.stackable)} onChange={(e) => set('stackable', e.target.checked)} /></CheckField>
        <CheckField label="First order only"><input type="checkbox" disabled={!canManage} checked={Boolean(form.firstOrderOnly)} onChange={(e) => set('firstOrderOnly', e.target.checked)} /></CheckField>
        <Field label="Restore policy"><select className="form-field__input" disabled={!canManage} value={form.restorePolicy} onChange={(e) => set('restorePolicy', e.target.value)}>{['CONFIG_REQUIRED', 'NEVER_RESTORE', 'RESTORE_ON_FULL_CANCEL', 'RESTORE_ON_FULL_REFUND'].map((s) => <option key={s}>{s}</option>)}</select></Field>
      </div>
      {canManage && <Button busy={saveState.busy} onClick={submit}>Save rule</Button>}

      <h3>Coupon codes</h3>
      <ul>{(p.coupons ?? []).map((c) => <li key={c.id}><code>{c.code}</code> · {c.status}</li>)}
        {(p.coupons ?? []).length === 0 && <li>No coupon codes {p.triggerType === 'AUTOMATIC' ? '(automatic — no code needed)' : '— add one below'}.</li>}
      </ul>
      {canManage && (
        <div className="editor-actions">
          <input className="form-field__input" style={{ maxWidth: 220 }} placeholder="NEWCODE" value={code} onChange={(e) => setCode(e.target.value)} />
          <Button variant="soft" busy={couponState.busy} disabled={code.trim().length < 3} onClick={async () => { await addCoupon(); setCode(''); reload(); }}>Add code</Button>
        </div>
      )}
      {couponState.error && <InlineAlert tone="error">{couponState.error.message}</InlineAlert>}
    </PageShell>
  );
}

export default PromotionDetailPage;
