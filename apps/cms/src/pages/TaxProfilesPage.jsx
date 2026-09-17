import { useState } from 'react';
import { PageShell } from '../layout/PageShell.jsx';
import { Button } from '../components/ui/Button.jsx';
import { FormField } from '../components/ui/FormField.jsx';
import { InlineAlert } from '../components/feedback/InlineAlert.jsx';
import { LoadingState } from '../components/feedback/LoadingState.jsx';
import { ErrorState } from '../components/feedback/ErrorState.jsx';
import { adminApi } from '../api/adminApi.js';
import { useApiResource } from '../hooks/useApiResource.js';
import { useMutation } from '../features/catalog/useMutation.js';
import { useAuth } from '../auth/useAuth.js';
import { RateBandsEditor, RateBandsSummary } from '../features/tax/RateBandsEditor.jsx';
import { DEFAULT_FORM_BANDS, bandsProblem, formatRate, profileRateLabel, toApiBands, toFormBands } from '../features/tax/rateBands.js';

const EMPTY = { name: '', description: '', hsnSac: '', taxability: 'TAXABLE', gstRatePct: '', useBands: false, bands: DEFAULT_FORM_BANDS, effectiveFrom: '', effectiveTo: '' };

export function TaxProfilesPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('tax.manage');
  const profiles = useApiResource(() => adminApi.tax.list());
  const gaps = useApiResource(() => adminApi.tax.gaps());
  const [form, setForm] = useState(EMPTY);
  const [create, createState] = useMutation((body) => adminApi.tax.create(body));
  const [patchBands, patchState] = useMutation(({ id, rateBands }) => adminApi.tax.patch(id, { rateBands }));
  const [patchDetails, detailsState] = useMutation(({ id, name, description }) => adminApi.tax.patch(id, { name, description }));
  // A profile's name and description could only be set at creation, so a
  // profile whose rate changed (e.g. "GST 12%" given 5%/18% bands) kept a
  // label that no longer matched its rate.
  const [details, setDetails] = useState(null); // { id, name, description }
  const [assign, assignState] = useMutation(({ productId, taxProfileId }) => adminApi.tax.assign(productId, taxProfileId));
  const [assignChoice, setAssignChoice] = useState({});
  const [editing, setEditing] = useState(null); // { id, bands }

  const set = (k) => (v) => setForm((s) => ({ ...s, [k]: v }));
  const createBandsProblem = form.useBands ? bandsProblem(form.bands) : null;
  // A blank rate used to be sent as 0 and created a 0% profile without a word.
  const rateMissing = !form.useBands && String(form.gstRatePct).trim() === '';

  const submit = async (e) => {
    e.preventDefault();
    try {
      await create({
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        hsnSac: form.hsnSac.trim(),
        taxability: form.taxability,
        ...(form.useBands
          ? { rateBands: toApiBands(form.bands) }
          : { gstRateBps: Math.round(Number(form.gstRatePct) * 100) }),
        // Optional in the UI — the server defaults it to today when omitted.
        effectiveFrom: form.effectiveFrom || undefined,
        effectiveTo: form.effectiveTo || undefined,
      });
    } catch {
      return; // shown from createState.error; the form keeps what was typed
    }
    setForm(EMPTY); profiles.reload();
  };

  const saveBands = async (rateBands) => {
    try {
      await patchBands({ id: editing.id, rateBands });
    } catch {
      return; // shown from patchState.error
    }
    setEditing(null); profiles.reload();
  };

  const saveDetails = async () => {
    try {
      await patchDetails({ id: details.id, name: details.name.trim(), description: details.description.trim() });
    } catch {
      return; // shown from detailsState.error
    }
    setDetails(null); profiles.reload();
  };

  const error = createState.error || patchState.error || detailsState.error || assignState.error;
  const columns = canManage ? 8 : 7;

  return (
    <PageShell title="Tax Profiles" description="HSN / GST rate configuration. Missing configuration BLOCKS invoice issuance — it is never treated as zero tax.">
      {error && <InlineAlert tone="error">{error.message}</InlineAlert>}

      {canManage && (
        <form className="editor-form" style={{ maxWidth: 560, marginBottom: 24 }} onSubmit={submit}>
          <h3>New tax profile</h3>

          <FormField id="name" label="Tax profile name" value={form.name} onChange={set('name')} required
            placeholder="Enter a name for this tax profile" />
          <p className="tab-body__hint">A short label so you can recognise it later — e.g. &ldquo;Apparel (5% / 18% by price)&rdquo;.</p>

          <label className="form-field">
            <span className="form-field__label">Description</span>
            <textarea className="form-field__input" rows={2} value={form.description}
              onChange={(e) => set('description')(e.target.value)}
              placeholder="Describe what this tax profile is used for" />
          </label>

          <FormField id="hsn" label="HSN / SAC code" value={form.hsnSac} onChange={set('hsnSac')} required placeholder="e.g. 61091000" />
          <p className="tab-body__hint">The 4–8 digit HSN/SAC that appears on the GST invoice for products using this profile.</p>

          <label className="form-field"><span className="form-field__label">Taxability</span>
            <select className="form-field__input" value={form.taxability} onChange={(e) => set('taxability')(e.target.value)}>
              {['TAXABLE', 'EXEMPT', 'NIL_RATED', 'ZERO_RATED'].map((t) => <option key={t}>{t}</option>)}
            </select>
          </label>

          <label className="form-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={form.useBands} onChange={(e) => set('useBands')(e.target.checked)} />
            <span className="form-field__label" style={{ margin: 0 }}>GST rate depends on the price of each piece</span>
          </label>

          {form.useBands ? (
            <>
              <RateBandsEditor idPrefix="new-band" bands={form.bands} onChange={set('bands')} />
              <p className="tab-body__hint">
                The rate is chosen per piece from its taxable value: the price after discount, without GST.
                Garments: up to ₹2,500 → 5%, above → 18%. Prices on the store include GST; the invoice takes it out.
              </p>
              {createBandsProblem && <p className="tab-body__hint" role="status">{createBandsProblem}</p>}
            </>
          ) : (
            <>
              <FormField id="rate" label="GST rate (%)" type="number" value={form.gstRatePct} onChange={set('gstRatePct')} required placeholder="e.g. 5 or 18" />
              <p className="tab-body__hint">One rate for every price. For garments priced both below and above ₹2,500 a piece, use price bands instead.</p>
            </>
          )}

          <FormField id="from" label="Effective from (Optional)" type="date" value={form.effectiveFrom} onChange={set('effectiveFrom')}
            placeholder="Select the date from which this tax profile will apply" />
          <p className="tab-body__hint">The GST rate applies to orders placed on or after this date. Leave blank to start from today.</p>

          <FormField id="to" label="Effective to (Optional)" type="date" value={form.effectiveTo} onChange={set('effectiveTo')} />
          <p className="tab-body__hint">Optional end date — leave blank if the rate has no expiry.</p>

          <div className="editor-actions">
            <Button type="submit" busy={createState.busy} disabled={!form.name.trim() || !form.hsnSac.trim() || rateMissing || Boolean(createBandsProblem)}>Create profile</Button>
          </div>
        </form>
      )}

      {profiles.status === 'loading' && <LoadingState label="Loading tax profiles…" />}
      {profiles.status === 'error' && <ErrorState message={profiles.error?.message} onRetry={profiles.reload} />}
      {profiles.status === 'ready' && (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Name</th><th>Description</th><th>HSN</th><th>Taxability</th><th>GST</th><th>Effective</th><th>Status</th>{canManage && <th>Actions</th>}</tr></thead>
            <tbody>
              {(profiles.data?.taxProfiles ?? []).map((p) => {
                const bands = p.rateBands || [];
                const isEditing = editing?.id === p.id;
                const editProblem = isEditing ? bandsProblem(editing.bands) : null;
                const isEditingDetails = details?.id === p.id;
                const detailsProblem = isEditingDetails
                  ? (!details.name.trim() ? 'Enter a name.' : details.name.trim().length > 120 ? 'Keep the name within 120 characters.' : details.description.trim().length > 255 ? 'Keep the description within 255 characters.' : null)
                  : null;
                return [
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td className="text-faint">{p.description || '—'}</td>
                    <td>{p.hsn_sac}</td><td>{p.taxability}</td>
                    <td>{bands.length ? <RateBandsSummary rateBands={bands} /> : formatRate(p.gst_rate_bps)}</td>
                    <td>{String(p.effective_from).slice(0, 10)} → {p.effective_to ? String(p.effective_to).slice(0, 10) : '—'}</td>
                    <td><span className={`pill pill--${p.status === 'ACTIVE' ? 'good' : 'muted'}`}>{p.status}</span></td>
                    {canManage && (
                      <td>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                          {!isEditing && (
                            <Button type="button" variant="secondary"
                              onClick={() => { patchState.reset(); setDetails(null); setEditing({ id: p.id, bands: bands.length ? toFormBands(bands) : DEFAULT_FORM_BANDS }); }}>
                              {bands.length ? 'Edit bands' : 'Add bands'}
                            </Button>
                          )}
                          {!isEditingDetails && (
                            <Button type="button" variant="secondary"
                              onClick={() => { detailsState.reset(); setEditing(null); setDetails({ id: p.id, name: p.name || '', description: p.description || '' }); }}>
                              Edit details
                            </Button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>,
                  isEditing && (
                    <tr key={`${p.id}-bands`}>
                      <td colSpan={columns}>
                        <div style={{ display: 'grid', gap: 8, maxWidth: 560 }}>
                          <strong>Price bands for {p.name}</strong>
                          <RateBandsEditor idPrefix={`band-${p.id}`} bands={editing.bands} onChange={(next) => setEditing((s) => ({ ...s, bands: next }))} />
                          <p className="tab-body__hint">
                            Applies to invoices issued from now on. Issued invoices keep the rate they were issued with.
                          </p>
                          {editProblem && <p className="tab-body__hint" role="status">{editProblem}</p>}
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                            <Button type="button" busy={patchState.busy} disabled={Boolean(editProblem)} onClick={() => saveBands(toApiBands(editing.bands))}>Save bands</Button>
                            {bands.length > 0 && (
                              <Button type="button" variant="secondary" busy={patchState.busy} onClick={() => saveBands([])}>
                                Remove bands (keep {formatRate(p.gst_rate_bps)})
                              </Button>
                            )}
                            <Button type="button" variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  ),
                  isEditingDetails && (
                    <tr key={`${p.id}-details`}>
                      <td colSpan={columns}>
                        <div style={{ display: 'grid', gap: 8, maxWidth: 560 }}>
                          <strong>Details for {p.name}</strong>
                          <FormField id={`details-name-${p.id}`} label="Tax profile name" value={details.name} required
                            onChange={(v) => setDetails((s) => ({ ...s, name: v }))} />
                          <label className="form-field">
                            <span className="form-field__label">Description</span>
                            <textarea className="form-field__input" rows={2} value={details.description}
                              onChange={(e) => setDetails((s) => ({ ...s, description: e.target.value }))} />
                          </label>
                          <p className="tab-body__hint">
                            Renaming changes how the profile appears in the CMS. Issued invoices are not affected; they show the HSN and rate, not this name.
                          </p>
                          {detailsProblem && <p className="tab-body__hint" role="status">{detailsProblem}</p>}
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                            <Button type="button" busy={detailsState.busy} disabled={Boolean(detailsProblem)} onClick={saveDetails}>Save details</Button>
                            <Button type="button" variant="secondary" onClick={() => setDetails(null)}>Cancel</Button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
      )}

      <h3>Products missing tax configuration</h3>
      {gaps.status === 'ready' && (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Product</th><th>SKU</th><th>Order</th>{canManage && <th>Assign</th>}</tr></thead>
            <tbody>
              {(gaps.data?.gaps ?? []).map((g) => (
                <tr key={`${g.product_id}-${g.order_id}`}>
                  <td>
                    {g.product_name}
                    {g.reason === 'TAX_PROFILE_NOT_EFFECTIVE' && <div className="text-faint">Profile inactive or not effective today</div>}
                  </td>
                  <td>{g.sku || '—'}</td>
                  {/* Product-level gaps have no order yet: they are listed so the
                      profile is set before the first invoice is blocked. */}
                  <td>{g.order_number || <span className="text-faint">No order yet</span>}</td>
                  {canManage && (
                    <td>
                      {/* A flex <td> stops behaving as a table cell and squeezed the
                          select to 50px on a phone; the row lives in a wrapper. */}
                      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                      <select className="form-field__input control--sm" style={{ minWidth: 160, maxWidth: 220 }} aria-label={`Tax profile for ${g.product_name}`} value={assignChoice[g.product_id] || ''} onChange={(e) => setAssignChoice((s) => ({ ...s, [g.product_id]: e.target.value }))}>
                        <option value="">Profile…</option>
                        {(profiles.data?.taxProfiles ?? []).filter((p) => p.status === 'ACTIVE').map((p) => <option key={p.id} value={p.id}>{p.name} ({profileRateLabel(p)})</option>)}
                      </select>
                      <Button variant="secondary" busy={assignState.busy} disabled={!assignChoice[g.product_id]}
                        onClick={async () => { await assign({ productId: g.product_id, taxProfileId: assignChoice[g.product_id] }); gaps.reload(); }}>Assign</Button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
              {(gaps.data?.gaps ?? []).length === 0 && <tr><td colSpan={canManage ? 4 : 3} className="data-table__empty">No configuration gaps.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </PageShell>
  );
}

export default TaxProfilesPage;
