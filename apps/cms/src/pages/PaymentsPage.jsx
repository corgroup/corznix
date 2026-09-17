import { useMemo, useState } from 'react';
import { PageShell } from '../layout/PageShell.jsx';
import { Button } from '../components/ui/Button.jsx';
import { FormField } from '../components/ui/FormField.jsx';
import { Badge } from '../components/ui/Badge.jsx';
import { Select } from '../components/ui/Select.jsx';
import { StatStrip } from '../components/ui/StatStrip.jsx';
import { InlineAlert } from '../components/feedback/InlineAlert.jsx';
import { LoadingState } from '../components/feedback/LoadingState.jsx';
import { ErrorState } from '../components/feedback/ErrorState.jsx';
import { adminApi } from '../api/adminApi.js';
import { useApiResource } from '../hooks/useApiResource.js';
import { succeeded, useMutation } from '../features/catalog/useMutation.js';
import { TruckIcon, CardIcon, LayersIcon, ShieldIcon, PinIcon, WarnIcon, InfoIcon, SearchIcon, ChartIcon } from './paymentsIcons.jsx';
import './PaymentsPage.css';

const TABS = ['Monitoring', 'COD control'];
const rupees = (minor) => `₹${(Number(minor || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const RANGES = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['last_7_days', 'Last 7 days'],
  ['last_30_days', 'Last 30 days'],
  ['month_to_date', 'Month to date'],
];

// Each blocker the evaluator can report, in the words an operator can act on.
// The raw code stays available as a title so a support conversation can quote it.
const BLOCKER_COPY = {
  GLOBAL_COD_DISABLED: ['COD switched off', 'Turn the master switch on. It is the first of several conditions.'],
  NO_ACTIVE_VALUE_RULE: ['No active order-value rule', 'Create an active order-value band that allows COD.'],
  NO_VALUE_RULE_ALLOWS_COD: ['COD disabled in all value rules', 'Enable COD in at least one active order-value band.'],
  VALUE_RULES_OVERLAP: ['Order-value bands overlap', 'Two active bands cover the same amount, so COD is refused for the overlap. Narrow one of them.'],
  RTO_POLICY_NOT_CONFIGURED: ['RTO policy not configured', 'Add an active RTO risk rule to determine COD eligibility.'],
};

function Chip({ tone, children }) {
  return <span className={`pay-chip${tone ? ` pay-chip--${tone}` : ''}`}>{children}</span>;
}

function Toggle({ checked, disabled, onChange, label }) {
  return (
    <span className="pay-toggle">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} aria-label={label} />
      <span className="pay-toggle__track" />
    </span>
  );
}

function CardHead({ icon, title, desc, children }) {
  return (
    <div className="pay-card__head">
      <span className="pay-card__icon">{icon}</span>
      <div className="pay-card__titles">
        <h3 className="pay-card__title">{title}</h3>
        <p className="pay-card__desc">{desc}</p>
      </div>
      <div className="pay-card__actions">{children}</div>
    </div>
  );
}

function EmptyState({ icon, title, body, action }) {
  return (
    <div className="pay-empty">
      <span className="pay-empty__icon">{icon}</span>
      <p className="pay-empty__title">{title}</p>
      <p className="pay-empty__body">{body}</p>
      {action}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Monitoring
// ---------------------------------------------------------------------------
function Bucket({ label, bucket, tone }) {
  const count = Number(bucket?.count || 0);
  return (
    <div className="pay-bucket">
      <span className="pay-bucket__label">{label}</span>
      <span className={`pay-bucket__amount${tone ? ` pay-bucket__amount--${tone}` : ''}`}>{rupees(bucket?.amountMinor)}</span>
      <span className="pay-bucket__count">{count} {count === 1 ? 'payment' : 'payments'}</span>
    </div>
  );
}

function Monitoring() {
  const [range, setRange] = useState('last_7_days');
  const { status, data, error, reload } = useApiResource(() => adminApi.payments.monitor(range), [range]);

  if (status === 'loading') return <LoadingState label="Loading payments…" />;
  if (status === 'error') return <ErrorState message={error?.message} onRetry={reload} />;

  const m = data ?? {};
  const coverage = m.instrumentCoverage ?? {};
  const attention = m.attention?.expiredOpenAttempts ?? { count: 0, amountMinor: 0 };

  return (
    <>
      <div className="wb-toolbar">
        <Select id="pay-range" label="Period" value={range} onChange={(v) => setRange(v || 'last_7_days')} options={RANGES} />
        <span className="wb-toolbar__spacer" />
        <Button variant="secondary" onClick={reload}>Refresh</Button>
      </div>
      <p className="pay-section-sub">{m.period?.label} · {m.timezone}</p>

      <StatStrip cards={[
        { label: 'Collected', value: rupees(m.payments?.succeeded?.amountMinor), hint: `${m.payments?.succeeded?.count ?? 0} payments`, tone: 'good' },
        { label: 'Failed', value: rupees(m.payments?.failed?.amountMinor), hint: `${m.payments?.failed?.count ?? 0} attempts`, tone: m.payments?.failed?.count ? 'warn' : 'neutral' },
        { label: 'Still open', value: rupees(m.payments?.open?.amountMinor), hint: `${m.payments?.open?.count ?? 0} not concluded`, tone: 'neutral' },
        { label: 'Refunded', value: rupees(m.refunds?.succeeded?.amountMinor), hint: `${m.refunds?.succeeded?.count ?? 0} refunds`, tone: 'neutral' },
      ]} />

      {attention.count > 0 && (
        <InlineAlert tone="warn">
          {attention.count} payment{attention.count === 1 ? '' : 's'} worth {rupees(attention.amountMinor)} {attention.count === 1 ? 'is' : 'are'} still
          open past its session expiry — neither collected nor failed. {m.attention?.note}
        </InlineAlert>
      )}

      <div className="pay-card" style={{ marginTop: 'var(--space-4)' }}>
        <CardHead icon={<ChartIcon />} title="Where the money is" desc={m.payments?.note} />
        <div className="pay-buckets">
          <Bucket label="Collected" bucket={m.payments?.succeeded} tone="good" />
          <Bucket label="Failed" bucket={m.payments?.failed} />
          <Bucket label="Cancelled / expired" bucket={m.payments?.cancelled} />
          <Bucket label="Still open" bucket={m.payments?.open} />
        </div>
      </div>

      <div className="pay-card">
        <CardHead
          icon={<CardIcon />} title="By payment method"
          desc="How customers actually paid. Only what the gateway reported — nothing is inferred."
        >
          <Chip>{coverage.recordedAttempts ?? 0} recorded</Chip>
        </CardHead>
        {coverage.unrecordedAttempts > 0 && (
          <InlineAlert tone="info">
            {coverage.recordedAttempts} of {coverage.recordedAttempts + coverage.unrecordedAttempts} attempts in this
            period have the method recorded. {coverage.note}
          </InlineAlert>
        )}
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Method</th><th>Collected</th><th>Failed</th><th>Cancelled</th><th>Still open</th><th>Provider detail</th></tr></thead>
            <tbody>
              {(m.byInstrument ?? []).map((row) => (
                <tr key={row.group || 'not-recorded'}>
                  <td>{row.recorded ? row.label : <span className="text-faint">{row.label}</span>}</td>
                  <td>{rupees(row.succeeded.amountMinor)} <span className="text-faint">({row.succeeded.count})</span></td>
                  <td>{rupees(row.failed.amountMinor)} <span className="text-faint">({row.failed.count})</span></td>
                  <td>{rupees(row.cancelled.amountMinor)} <span className="text-faint">({row.cancelled.count})</span></td>
                  <td>{rupees(row.open.amountMinor)} <span className="text-faint">({row.open.count})</span></td>
                  <td className="text-faint">{row.methods.join(', ') || '—'}</td>
                </tr>
              ))}
              {(m.byInstrument ?? []).length === 0 && (
                <tr><td colSpan={6}><EmptyState icon={<CardIcon size={24} />} title="No payment attempts" body="Nothing was attempted in this period." /></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="pay-card">
        <CardHead icon={<TruckIcon />} title="Cash on delivery" desc={m.cod?.note} />
        <StatStrip cards={[
          { label: 'COD orders', value: m.cod?.orders ?? 0, tone: 'neutral' },
          { label: 'Due at the door', value: rupees(m.cod?.dueMinor), tone: 'neutral' },
          { label: 'Collected', value: rupees(m.cod?.collectedMinor), tone: 'good' },
          { label: 'Outstanding', value: rupees(m.cod?.outstandingMinor), tone: (m.cod?.outstandingMinor ?? 0) > 0 ? 'warn' : 'neutral' },
        ]} />
        <p className="pay-section-sub" style={{ marginTop: 'var(--space-3)' }}>
          Prepaid: {m.prepaid?.orders ?? 0} orders, {rupees(m.prepaid?.paidMinor)} paid online.
        </p>
      </div>

      <div className="pay-card">
        <CardHead
          icon={<CardIcon />} title="Refunds"
          desc="Grouped by how the money went back. A COD refund is not a gateway reversal and is never shown as one."
        />
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>How it was refunded</th><th>Succeeded</th><th>Failed</th><th>In progress</th><th>Unknown</th></tr></thead>
            <tbody>
              {(m.refunds?.byMethod ?? []).map((row) => (
                <tr key={row.method}>
                  <td>{row.method === 'NOT_RECORDED' ? <span className="text-faint">Not recorded</span> : row.method}</td>
                  <td>{rupees(row.succeeded.amountMinor)} <span className="text-faint">({row.succeeded.count})</span></td>
                  <td>{rupees(row.failed.amountMinor)} <span className="text-faint">({row.failed.count})</span></td>
                  <td>{rupees(row.processing.amountMinor)} <span className="text-faint">({row.processing.count})</span></td>
                  <td>{rupees(row.unknown.amountMinor)} <span className="text-faint">({row.unknown.count})</span></td>
                </tr>
              ))}
              {(m.refunds?.byMethod ?? []).length === 0 && (
                <tr><td colSpan={5}><EmptyState icon={<CardIcon size={24} />} title="No refunds" body="Nothing was refunded in this period." /></td></tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="pay-section-sub">{m.refunds?.note}</p>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// COD control
// ---------------------------------------------------------------------------
const RISK_LEVELS = ['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CUSTOM'];
const RISK_ACTIONS = [
  ['ALLOW_FULL_COD', 'Allow full COD'],
  ['REQUIRE_PARTIAL_COD', 'Require partial COD'],
  ['PREPAID_ONLY', 'Prepaid only'],
];
const PARTIAL_MODES = [['DISABLED', 'Not offered'], ['AVAILABLE', 'Offered'], ['REQUIRED', 'Required']];

const rupeesToMinor = (value) => {
  const n = Number(String(value).trim());
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};

const EMPTY_BAND = { id: null, min: '', max: '', codAllowed: true, partialCodMode: 'DISABLED', advanceType: 'PERCENTAGE', advanceValue: '', advanceNonRefundable: false };

function ValueBandForm({ initial, onCancel, onSave, busy }) {
  const [form, setForm] = useState(() => (initial
    ? {
      id: initial.id,
      min: (initial.minAmountMinor / 100).toString(),
      max: initial.maxAmountMinor == null ? '' : (initial.maxAmountMinor / 100).toString(),
      codAllowed: initial.codAllowed,
      partialCodMode: initial.partialCodMode,
      advanceType: initial.advanceType || 'PERCENTAGE',
      advanceValue: initial.advanceValue == null ? '' : (initial.advanceValue / 100).toString(),
      advanceNonRefundable: Boolean(initial.advanceNonRefundable),
    }
    : EMPTY_BAND));
  const [err, setErr] = useState('');
  const set = (k) => (v) => setForm((s) => ({ ...s, [k]: v }));

  const submit = async (event) => {
    event.preventDefault();
    setErr('');
    const minMinor = rupeesToMinor(form.min);
    if (minMinor === null) { setErr('Enter a "from" amount in rupees.'); return; }
    let maxMinor = null;
    if (String(form.max).trim() !== '') {
      maxMinor = rupeesToMinor(form.max);
      if (maxMinor === null) { setErr('The "to" amount is not a valid number.'); return; }
      if (maxMinor < minMinor) { setErr('The "to" amount must be at or above the "from" amount.'); return; }
    }
    // "Offered" means the customer chooses between partial and full COD, so
    // full COD has to be on the table. Without it the evaluator falls back to
    // prepaid-only while still computing a split — telling the customer one
    // thing and the API another. "Required" is how a band offers partial alone.
    if (form.partialCodMode === 'AVAILABLE' && !form.codAllowed) {
      setErr('Partial COD set to "offered" needs full COD allowed as the alternative. To offer only partial COD, choose "required".');
      return;
    }
    const body = {
      id: form.id, minAmountMinor: minMinor, maxAmountMinor: maxMinor,
      codAllowed: form.codAllowed, partialCodMode: form.partialCodMode, status: 'ACTIVE',
    };
    if (form.partialCodMode !== 'DISABLED') {
      const raw = Number(String(form.advanceValue).trim());
      if (!Number.isFinite(raw) || raw <= 0) { setErr('Enter the advance the customer pays online.'); return; }
      body.advanceType = form.advanceType;
      body.advanceValue = Math.round(raw * 100); // percentage -> basis points, rupees -> paise
      body.advanceNonRefundable = form.advanceNonRefundable;
      if (form.advanceType === 'PERCENTAGE' && (body.advanceValue < 1 || body.advanceValue > 10000)) {
        setErr('A percentage advance must be between 0.01% and 100%.'); return;
      }
    }
    await onSave(body);
  };

  return (
    <form className="editor-form pay-form" onSubmit={submit} style={{ maxWidth: 640 }}>
      <div className="pay-form-row">
        <FormField id="band-min" label="From (₹)" type="number" value={form.min} onChange={set('min')} required />
        <FormField id="band-max" label="To (₹) — empty means no upper limit" type="number" value={form.max} onChange={set('max')} />
      </div>
      <label htmlFor="band-cod" style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 400 }}>
        <input id="band-cod" type="checkbox" checked={form.codAllowed} style={{ width: 'auto', margin: 0 }}
          onChange={(e) => set('codAllowed')(e.target.checked)} />
        Allow full COD for orders in this band
      </label>
      <label htmlFor="band-partial">Partial COD</label>
      <select id="band-partial" value={form.partialCodMode} onChange={(e) => set('partialCodMode')(e.target.value)}>
        {PARTIAL_MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      {form.partialCodMode !== 'DISABLED' && (
        <>
          <label htmlFor="band-advance-type">Advance paid online</label>
          <select id="band-advance-type" value={form.advanceType} onChange={(e) => set('advanceType')(e.target.value)}>
            <option value="PERCENTAGE">A percentage of the order</option>
            <option value="FIXED">A fixed amount</option>
          </select>
          <FormField
            id="band-advance" type="number" value={form.advanceValue} onChange={set('advanceValue')}
            label={form.advanceType === 'PERCENTAGE' ? 'Advance (%)' : 'Advance (₹)'} required
          />
          <label htmlFor="band-nonrefundable" style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 400 }}>
            <input
              id="band-nonrefundable" type="checkbox" checked={form.advanceNonRefundable} style={{ width: 'auto', margin: 0 }}
              onChange={(e) => set('advanceNonRefundable')(e.target.checked)}
            />
            The advance is non-refundable
          </label>
          <p className="pay-section-sub">
            Ticked, the advance is kept if the order is cancelled or returned. What the customer pays at the door is
            still refunded in full, and a fully prepaid order is not affected at all. The customer is told at
            checkout before they pay, and the amount is stored on the order — so editing this band later never
            changes what an existing customer is owed.
          </p>
          <p className="pay-section-sub">
            The advance must come to more than zero and less than the order total, or checkout offers full COD
            instead — it will not quietly charge everything up front.
          </p>
        </>
      )}
      {err && <InlineAlert tone="error">{err}</InlineAlert>}
      <div className="editor-actions">
        <Button variant={form.id ? 'primary' : 'soft'} type="submit" busy={busy}>{form.id ? 'Save band' : 'Add band'}</Button>
        <Button variant="ghost" onClick={onCancel} type="button">Cancel</Button>
      </div>
    </form>
  );
}

function CodControl() {
  const [pinSearch, setPinSearch] = useState('');
  const { status, data, error, reload } = useApiResource(() => adminApi.payments.codPolicy({ pin: pinSearch }), [pinSearch]);
  const [run, state] = useMutation((fn) => fn());
  const [newPin, setNewPin] = useState('');
  const [bandForm, setBandForm] = useState(null);
  const [newRisk, setNewRisk] = useState(null);

  // The two switches are edited together and applied on Save, so COD is never
  // briefly on with nothing behind it. Everything else on this page is a
  // discrete record with its own action and saves immediately.
  //
  // `pending` is null until something is actually changed, so the displayed
  // state is derived from the server rather than copied into state by an
  // effect — a copy would go stale the moment a save or reload landed.
  const [pending, setPending] = useState(null);

  const act = async (fn) => { if (await succeeded(run(fn))) reload(); };
  const settings = data?.settings ?? {};
  const saved = {
    codEnabled: Boolean(settings.codEnabled),
    partialCodEnabled: Boolean(settings.partialCodEnabled),
    advanceNonRefundableEnabled: Boolean(settings.advanceNonRefundableEnabled),
  };
  const draft = pending ?? saved;
  const dirty = pending !== null && (draft.codEnabled !== saved.codEnabled
    || draft.partialCodEnabled !== saved.partialCodEnabled
    || draft.advanceNonRefundableEnabled !== saved.advanceNonRefundableEnabled);
  const setSwitch = (key) => setPending({ ...draft, [key]: !draft[key] });

  const blockers = useMemo(() => data?.readiness?.blockers ?? [], [data]);
  const activeBands = (data?.valueRules ?? []).filter((r) => r.status === 'ACTIVE');
  const activeRisks = (data?.riskRules ?? []).filter((r) => r.status === 'ACTIVE');
  const pins = data?.pins ?? { total: 0, pins: [] };

  if (status === 'loading') return <LoadingState label="Loading COD policy…" />;
  if (status === 'error') return <ErrorState message={error?.message} onRetry={reload} />;

  const saveSettings = async () => {
    if (saved.codEnabled && !draft.codEnabled
      && !window.confirm('Turn COD off? Every checkout stops offering cash on delivery straight away.')) return;
    await act(() => adminApi.payments.setCodSettings(draft));
    setPending(null); // fall back to whatever the server now reports
  };

  return (
    <>
      {state.error && <InlineAlert tone="error">{state.error.message}</InlineAlert>}

      <div className="pay-card">
        <CardHead
          icon={<TruckIcon />}
          title="Cash on delivery"
          desc="The master switch checkout consults before it offers COD. Turning it off removes COD from every order immediately; turning it on is only the first of several conditions below."
        >
          <Chip tone={draft.codEnabled ? 'good' : undefined}>{draft.codEnabled ? 'Enabled' : 'Disabled'}</Chip>
          <Toggle
            checked={draft.codEnabled} disabled={state.busy}
            onChange={() => setSwitch('codEnabled')}
            label="COD enabled"
          />
        </CardHead>

        {data?.readiness?.codReachable
          ? (
            <div className="pay-note" style={{ marginTop: 'var(--space-4)' }}>
              <InfoIcon />
              <span>COD is reachable. Whether a given order can use it still depends on the carrier&apos;s own COD support for that PIN and the order total.</span>
            </div>
          )
          : (
            <div className="pay-blockers">
              <div className="pay-blockers__head">
                <span className="pay-blockers__icon"><WarnIcon /></span>
                <div className="pay-blockers__titles">
                  <p className="pay-blockers__title">
                    COD is not available at checkout
                    <Chip tone="warn">{blockers.length} configuration {blockers.length === 1 ? 'issue' : 'issues'}</Chip>
                  </p>
                  <p className="pay-blockers__sub">Fix the following to make COD available at checkout.</p>
                </div>
              </div>
              <ul className="pay-blockers__list">
                {blockers.map((b) => {
                  const [label, help] = BLOCKER_COPY[b.code] ?? [b.code, b.detail];
                  return (
                    <li className="pay-blockers__row" key={b.code} title={b.code}>
                      <span className="pay-blockers__icon"><WarnIcon size={16} /></span>
                      <b>{label}</b>
                      <span>{help}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
      </div>

      <div className="pay-card">
        <CardHead
          icon={<CardIcon />}
          title="Partial COD"
          desc="Collect an advance payment online and the remaining amount at delivery."
        >
          <Toggle
            checked={draft.partialCodEnabled} disabled={state.busy}
            onChange={() => setSwitch('partialCodEnabled')}
            label="Partial COD enabled"
          />
        </CardHead>
      </div>

      <div className="pay-card">
        <CardHead
          icon={<ShieldIcon />}
          title="Non-refundable advance"
          desc="Keep the advance if a partial-COD order is cancelled or returned. What the customer pays at the door is always refunded, and a fully prepaid order is never affected. Each order-value band decides separately whether its advance is covered; this switch turns the whole policy off at once."
        >
          <Chip tone={draft.advanceNonRefundableEnabled ? 'good' : undefined}>
            {draft.advanceNonRefundableEnabled ? 'Enforced' : 'Off'}
          </Chip>
          <Toggle
            checked={draft.advanceNonRefundableEnabled} disabled={state.busy}
            onChange={() => setSwitch('advanceNonRefundableEnabled')}
            label="Non-refundable advance enforced"
          />
        </CardHead>
        {draft.advanceNonRefundableEnabled && !(data?.valueRules ?? []).some((r) => r.status === 'ACTIVE' && r.advanceNonRefundable) && (
          <div className="pay-note" style={{ marginTop: 'var(--space-3)' }}>
            <InfoIcon />
            <span>No active band marks its advance non-refundable yet, so nothing is being withheld. Tick it on a band below.</span>
          </div>
        )}
      </div>

      <h3 className="pay-section-title">Eligibility rules</h3>
      <p className="pay-section-sub">The conditions checkout evaluates to decide whether an order may pay cash.</p>

      {/* ---- order-value bands ---- */}
      <div className="pay-card">
        <CardHead
          icon={<LayersIcon />}
          title="Order-value bands"
          desc={<>COD applies only when <strong>exactly one</strong> active band matches the order total. Overlapping bands cancel each other out.</>}
        >
          <Chip tone={activeBands.length ? 'good' : 'warn'}>{activeBands.length} active {activeBands.length === 1 ? 'rule' : 'rules'}</Chip>
          {bandForm === null && <Button variant="soft" onClick={() => setBandForm({})}>Add value band</Button>}
        </CardHead>

        {bandForm !== null && (
          <ValueBandForm
            initial={bandForm.id ? bandForm : null}
            busy={state.busy}
            onCancel={() => setBandForm(null)}
            onSave={async (body) => { await act(() => adminApi.payments.saveValueRule(body)); setBandForm(null); }}
          />
        )}

        <div className="table-wrap" style={{ marginTop: 'var(--space-3)' }}>
          <table className="data-table">
            <thead><tr><th>Order value</th><th>COD</th><th>Partial COD</th><th>Advance</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {(data?.valueRules ?? []).map((r) => (
                <tr key={r.id}>
                  <td>{rupees(r.minAmountMinor)} — {r.maxAmountMinor == null ? <span className="text-faint">no upper limit</span> : rupees(r.maxAmountMinor)}</td>
                  <td><Badge tone={r.codAllowed ? 'good' : 'muted'}>{r.codAllowed ? 'Allowed' : 'Blocked'}</Badge></td>
                  <td>{PARTIAL_MODES.find(([v]) => v === r.partialCodMode)?.[1] ?? r.partialCodMode}</td>
                  <td>
                    {r.advanceType ? (r.advanceType === 'PERCENTAGE' ? `${(r.advanceValue / 100).toFixed(2)}%` : rupees(r.advanceValue)) : '—'}
                    {r.advanceNonRefundable && <><br /><span className="text-faint">non-refundable</span></>}
                  </td>
                  <td><Badge>{r.status}</Badge></td>
                  <td>
                    {r.status === 'ACTIVE' && (
                      <>
                        <button type="button" className="linkish" disabled={state.busy} onClick={() => setBandForm(r)}>Edit</button>
                        {' · '}
                        <button
                          type="button" className="linkish linkish--danger" disabled={state.busy}
                          onClick={() => { if (window.confirm('Archive this band? Orders in its range stop qualifying for COD.')) act(() => adminApi.payments.archiveValueRule(r.id)); }}
                        >
                          Archive
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {(data?.valueRules ?? []).length === 0 && (
                <tr><td colSpan={6}>
                  <EmptyState
                    icon={<LayersIcon size={24} />}
                    title="No order-value bands"
                    body="Add a rule to define which order totals are eligible for COD."
                    action={bandForm === null ? <Button variant="soft" onClick={() => setBandForm({})}>Create first band</Button> : null}
                  />
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

        {(data?.valueRuleOverlaps ?? []).length > 0 && (
          <InlineAlert tone="error">
            {data.valueRuleOverlaps.length} pair{data.valueRuleOverlaps.length === 1 ? '' : 's'} of active bands overlap.
            COD is refused for amounts inside the overlap — narrow one of them.
          </InlineAlert>
        )}
      </div>

      {/* ---- RTO risk rules ---- */}
      <div className="pay-card">
        <CardHead
          icon={<ShieldIcon />}
          title="RTO risk rules"
          desc="How COD behaves for each order risk level. An order whose risk level has no active rule is refused COD."
        >
          <Chip tone={activeRisks.length ? 'good' : 'warn'}>{activeRisks.length} active {activeRisks.length === 1 ? 'rule' : 'rules'}</Chip>
          {newRisk === null && <Button variant="soft" onClick={() => setNewRisk({ riskLevel: 'UNKNOWN', action: 'ALLOW_FULL_COD' })}>Add risk rule</Button>}
        </CardHead>

        {!activeRisks.some((r) => r.riskLevel === 'UNKNOWN') && (
          <div className="pay-note" style={{ marginTop: 'var(--space-3)', background: 'var(--warn-bg)', borderColor: 'transparent', color: 'var(--warn-fg)' }}>
            <WarnIcon />
            <span>Add an <strong>UNKNOWN</strong> rule to cover orders that do not receive a specific risk score — that is most of them.</span>
          </div>
        )}

        {newRisk !== null && (
          <form
            className="editor-form pay-form" style={{ maxWidth: 520 }}
            onSubmit={async (e) => { e.preventDefault(); await act(() => adminApi.payments.saveRiskRule(newRisk.riskLevel, { action: newRisk.action, status: 'ACTIVE' })); setNewRisk(null); }}
          >
            <label htmlFor="risk-level">Risk level</label>
            <select id="risk-level" value={newRisk.riskLevel} onChange={(e) => setNewRisk((s) => ({ ...s, riskLevel: e.target.value }))}>
              {RISK_LEVELS.map((l) => <option key={l} value={l}>{l}{l === 'UNKNOWN' ? ' — most orders' : ''}</option>)}
            </select>
            <label htmlFor="risk-action">What COD does</label>
            <select id="risk-action" value={newRisk.action} onChange={(e) => setNewRisk((s) => ({ ...s, action: e.target.value }))}>
              {RISK_ACTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <div className="editor-actions">
              <Button type="submit" busy={state.busy}>Save rule</Button>
              <Button variant="ghost" type="button" onClick={() => setNewRisk(null)}>Cancel</Button>
            </div>
          </form>
        )}

        <div className="table-wrap" style={{ marginTop: 'var(--space-3)' }}>
          <table className="data-table">
            <thead><tr><th>Risk level</th><th>Action</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {(data?.riskRules ?? []).map((r) => (
                <tr key={r.riskLevel}>
                  <td>{r.riskLevel}{r.riskLevel === 'UNKNOWN' && <span className="text-faint"> · most orders</span>}</td>
                  <td>
                    <select
                      value={r.action} disabled={state.busy}
                      onChange={(e) => act(() => adminApi.payments.saveRiskRule(r.riskLevel, { action: e.target.value, status: r.status }))}
                      aria-label={`${r.riskLevel} risk action`}
                    >
                      {RISK_ACTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </td>
                  <td><Badge>{r.status}</Badge></td>
                  <td>
                    <button
                      type="button" className="linkish" disabled={state.busy}
                      onClick={() => act(() => adminApi.payments.saveRiskRule(r.riskLevel, { action: r.action, status: r.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE' }))}
                    >
                      {r.status === 'ACTIVE' ? 'Archive' : 'Reactivate'}
                    </button>
                  </td>
                </tr>
              ))}
              {(data?.riskRules ?? []).length === 0 && (
                <tr><td colSpan={4}>
                  <EmptyState
                    icon={<ShieldIcon size={24} />}
                    title="No RTO risk rules"
                    body="Create rules to allow, block, or require partial COD by risk level."
                    action={newRisk === null ? <Button variant="soft" onClick={() => setNewRisk({ riskLevel: 'UNKNOWN', action: 'ALLOW_FULL_COD' })}>Create first rule</Button> : null}
                  />
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ---- PIN overrides ---- */}
      <div className="pay-card">
        <CardHead
          icon={<PinIcon />}
          title="PIN-code overrides"
          desc="Override COD or delivery for a specific 6-digit PIN code. PIN codes without an override inherit the rules above."
        >
          <Chip>{pins.total} {pins.total === 1 ? 'override' : 'overrides'}</Chip>
        </CardHead>

        <div className="wb-toolbar" style={{ marginTop: 'var(--space-3)' }}>
          <span className="pay-search">
            <span className="pay-search__icon"><SearchIcon /></span>
            <input
              className="wb-toolbar__search" type="search" placeholder="Search 6-digit PIN code" maxLength={6}
              value={pinSearch} onChange={(e) => setPinSearch(e.target.value.replace(/\D/g, '').slice(0, 6))}
            />
          </span>
          <input
            className="wb-toolbar__search" style={{ flex: '0 1 170px' }} placeholder="Add a PIN…" maxLength={6}
            value={newPin} onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
          />
          <Button variant="soft"
            busy={state.busy} disabled={newPin.length !== 6}
            onClick={async () => { await act(() => adminApi.payments.setPin(newPin, { codBlocked: true })); setNewPin(''); }}
          >
            Add PIN override
          </Button>
        </div>

        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>PIN code</th><th>COD</th><th>Delivery</th><th>Partial COD</th><th>Updated</th><th>Actions</th></tr></thead>
            <tbody>
              {pins.pins.map((p) => (
                <tr key={p.postalCode}>
                  <td><code>{p.postalCode}</code></td>
                  <td>
                    <Toggle checked={!p.codBlocked} disabled={state.busy} label={`${p.postalCode} COD allowed`}
                      onChange={() => act(() => adminApi.payments.setPin(p.postalCode, { codBlocked: !p.codBlocked }))} />
                    <span style={{ marginLeft: 8 }}>{p.codBlocked ? 'Blocked' : 'Allowed'}</span>
                  </td>
                  <td>
                    <Toggle checked={!p.deliveryBlocked} disabled={state.busy} label={`${p.postalCode} delivery allowed`}
                      onChange={() => act(() => adminApi.payments.setPin(p.postalCode, { deliveryBlocked: !p.deliveryBlocked }))} />
                    <span style={{ marginLeft: 8 }}>{p.deliveryBlocked ? 'Blocked' : 'Allowed'}</span>
                  </td>
                  <td>{p.partialCodBlocked ? 'Blocked' : 'Allowed'}</td>
                  <td className="text-faint">{p.updatedAt ? new Date(p.updatedAt).toLocaleDateString() : '—'}</td>
                  <td>
                    <button
                      type="button" className="linkish linkish--danger" disabled={state.busy}
                      onClick={() => { if (window.confirm(`Remove the override for ${p.postalCode}? It will inherit the rules above.`)) act(() => adminApi.payments.clearPin(p.postalCode)); }}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
              {pins.pins.length === 0 && (
                <tr><td colSpan={6}>
                  <EmptyState
                    icon={<PinIcon size={24} />}
                    title={pinSearch ? 'No PIN codes match' : 'No PIN-code overrides'}
                    body={pinSearch ? 'No override is stored for that PIN code.' : 'Only exceptions need to be added here.'}
                  />
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        {pins.total > pins.pins.length && <p className="pay-section-sub">Showing {pins.pins.length} of {pins.total}. Search to narrow it.</p>}
      </div>

      <div className="pay-note">
        <InfoIcon />
        <span>{data?.readiness?.note}</span>
      </div>

      {dirty && (
        <div className="pay-savebar">
          <span className="pay-savebar__text">The switches above have unsaved changes. Nothing at checkout has changed yet.</span>
          <Button variant="secondary" onClick={() => setPending(null)}>Discard</Button>
          <Button busy={state.busy} onClick={saveSettings}>Save changes</Button>
        </div>
      )}
    </>
  );
}

export function PaymentsPage() {
  const [tab, setTab] = useState(TABS[0]);
  return (
    <PageShell
      title="Payments"
      description="Manage how payments are collected and whether cash on delivery is offered at checkout. Gateway credentials live only in the backend environment and are never shown here."
    >
      <div className="wb-toolbar">
        {TABS.map((t) => (
          <Button key={t} variant={t === tab ? 'primary' : 'secondary'} onClick={() => setTab(t)}>{t}</Button>
        ))}
      </div>
      {tab === 'Monitoring' ? <Monitoring /> : <CodControl />}
    </PageShell>
  );
}

export default PaymentsPage;
