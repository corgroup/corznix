import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { PageShell } from '../../layout/PageShell.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { FormField } from '../../components/ui/FormField.jsx';
import { Select } from '../../components/ui/Select.jsx';
import { StatStrip } from '../../components/ui/StatStrip.jsx';
import { InlineAlert } from '../../components/feedback/InlineAlert.jsx';
import { LoadingState } from '../../components/feedback/LoadingState.jsx';
import { ErrorState } from '../../components/feedback/ErrorState.jsx';
import { adminApi } from '../../api/adminApi.js';
import { useApiResource } from '../../hooks/useApiResource.js';
import { useMutation, succeeded } from '../../features/catalog/useMutation.js';
import { useAuth } from '../../auth/useAuth.js';
import { AudienceListUpload } from './AudienceListUpload.jsx';
import {
  CHANNEL_LABEL, REGISTERED_FILTER_LABEL, describeAudience, formatDateTime, templateLabel, toLocalInput,
} from './campaignModel.js';
import './messaging.css';

// Messaging → Create campaign. Seven plain steps; each one is saved as the
// admin moves on, so a half-built campaign is a draft, never lost work. The
// backend decides readiness (templates approved, audience, schedule, consent)
// and the Review step shows exactly what it says.
const STEPS = ['Details', 'Channels', 'Message', 'Audience', 'Trigger', 'Review', 'Activate'];
const CART_DEFAULTS = { delayHours: 4, maxAgeDays: 7, cooldownDays: 7, minCartRupees: 0, couponCode: '' };

function fromCampaign(c) {
  const cfg = c?.trigger_config || {};
  const sources = c?.audience_sources || [];
  const registered = sources.find((s) => s.type === 'REGISTERED_USERS');
  return {
    name: c?.name || '',
    campaignType: c?.campaign_type || '',
    channels: Object.fromEntries((c?.channels || []).map((ch) => [ch.channel, ch.templateKey])),
    offerName: c?.offer_name || '',
    offerDetails: c?.offer_details || '',
    collectionSlug: c?.collection_slug || '',
    imageUrl: c?.image_url || '',
    ctaLabel: c?.cta_label || '',
    ctaUrl: c?.cta_url || '',
    registered: registered ? (registered.filter || 'ALL') : null,
    segmentId: sources.find((s) => s.type === 'SEGMENT')?.segmentId || null,
    emailSubscribers: sources.some((s) => s.type === 'EMAIL_SUBSCRIBERS'),
    whatsappSubscribers: sources.some((s) => s.type === 'WHATSAPP_SUBSCRIBERS'),
    listIds: sources.filter((s) => s.type === 'LIST').map((s) => s.listId),
    triggerKey: c?.trigger?.key || '',
    scheduledAt: toLocalInput(c?.scheduled_at),
    cart: c?.trigger_config ? {
      delayHours: Number(cfg.delayMinutes ?? 240) / 60,
      maxAgeDays: Number(cfg.maxAgeHours ?? 168) / 24,
      cooldownDays: Number(cfg.cooldownHours ?? 168) / 24,
      minCartRupees: Number(cfg.minCartValueMinor ?? 0) / 100,
      couponCode: cfg.couponCode || '',
    } : CART_DEFAULTS,
  };
}

export function CampaignBuilder() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('marketing.manage');
  const canSend = hasPermission('marketing.send');

  const options = useApiResource(() => adminApi.marketingCampaigns.options());
  const templates = useApiResource(() => adminApi.communications.listTemplates());
  const collections = useApiResource(() => adminApi.catalog.collections());
  const lists = useApiResource(() => adminApi.marketingCampaigns.listAudiences());
  const segments = useApiResource(() => (hasPermission('segments.read') ? adminApi.segments.list({ status: 'ACTIVE' }) : Promise.resolve({ segments: [] })));
  const existing = useApiResource(() => (id ? adminApi.marketingCampaigns.get(id) : Promise.resolve(null)));

  // Abandoned-cart reminders are created from their own section; everything
  // else from Campaigns.
  const presetType = params.get('type');
  const [form, setForm] = useState(() => ({ ...fromCampaign(null), campaignType: presetType === 'ABANDONED_CART' ? 'ABANDONED_CART' : '' }));
  const [loadedFor, setLoadedFor] = useState(null);
  const [notice, setNotice] = useState(null);
  const step = Math.min(Math.max(Number(params.get('step') || 1), 1), STEPS.length);

  // Adopt the saved campaign once per campaign id (after a save the server's
  // copy is re-read, but local edits in progress are not overwritten).
  useEffect(() => {
    if (existing.status !== 'ready' || !existing.data || loadedFor === existing.data.id) return;
    Promise.resolve().then(() => { setForm(fromCampaign(existing.data)); setLoadedFor(existing.data.id); });
  }, [existing.status, existing.data, loadedFor]);

  const campaign = existing.data;
  const allTypes = useMemo(() => options.data?.types ?? [], [options.data]);
  const type = allTypes.find((t) => t.key === form.campaignType);
  const cartSection = form.campaignType === 'ABANDONED_CART' || presetType === 'ABANDONED_CART';
  const types = useMemo(
    () => allTypes.filter((t) => (cartSection ? t.key === 'ABANDONED_CART' : t.key !== 'ABANDONED_CART')),
    [allTypes, cartSection],
  );
  const sectionPath = cartSection ? '/marketing/abandoned-carts' : '/marketing/campaigns';
  const triggers = useMemo(() => options.data?.triggers ?? [], [options.data]);
  const trigger = triggers.find((t) => t.key === form.triggerKey);
  const perCustomer = Boolean(trigger?.perCustomer || (form.campaignType === 'ABANDONED_CART'));
  const editable = !campaign || ['DRAFT', 'PAUSED'].includes(campaign.status);

  const [save, saveState] = useMutation((fn) => fn());
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const go = (n) => setParams(presetType ? { step: String(n), type: presetType } : { step: String(n) });

  const marketingTemplates = (channel) => (templates.data?.templates ?? [])
    .filter((t) => t.channel === channel && t.classification === 'MARKETING' && t.status === 'ACTIVE');
  // One row per key: the list holds every version.
  const templateChoices = (channel) => [...new Map(marketingTemplates(channel).map((t) => [t.templateKey, t])).values()];

  const audienceSources = () => [
    ...(form.registered ? [{ type: 'REGISTERED_USERS', filter: form.registered }] : []),
    ...(form.segmentId ? [{ type: 'SEGMENT', segmentId: form.segmentId }] : []),
    ...(form.emailSubscribers ? [{ type: 'EMAIL_SUBSCRIBERS' }] : []),
    ...(form.whatsappSubscribers ? [{ type: 'WHATSAPP_SUBSCRIBERS' }] : []),
    ...form.listIds.map((listId) => ({ type: 'LIST', listId })),
  ];

  const triggerBody = () => {
    if (form.triggerKey === 'scheduled') {
      return { key: 'scheduled', scheduledAt: form.scheduledAt ? new Date(form.scheduledAt).toISOString() : null };
    }
    if (form.triggerKey === 'cart.abandoned') {
      return {
        key: 'cart.abandoned',
        config: {
          delayMinutes: Math.round(Number(form.cart.delayHours) * 60),
          maxAgeHours: Math.round(Number(form.cart.maxAgeDays) * 24),
          cooldownHours: Math.round(Number(form.cart.cooldownDays) * 24),
          minCartValueMinor: Math.round(Number(form.cart.minCartRupees || 0) * 100),
          couponCode: form.cart.couponCode.trim() || null,
        },
      };
    }
    return { key: form.triggerKey || 'send_now' };
  };

  /** Save what this step owns, then move to `next`. */
  const saveStep = async (next) => {
    setNotice(null);
    if (step === 1) {
      if (!campaign) {
        const created = await save(() => adminApi.marketingCampaigns.create({
          name: form.name.trim(), campaignType: form.campaignType, trigger: { key: type?.suggestedTrigger || 'send_now' },
        })).catch(() => null);
        if (created) navigate(`/messaging/campaigns/${created.id}/edit?step=${next}`, { replace: true, state: { from: sectionPath } });
        return;
      }
      if (!await succeeded(save(() => adminApi.marketingCampaigns.update(campaign.id, { name: form.name.trim(), campaignType: form.campaignType })))) return;
    }
    if (step === 3) {
      const body = {
        channels: Object.entries(form.channels).map(([channel, templateKey]) => ({ channel, templateKey })),
        offerName: form.offerName || null, offerDetails: form.offerDetails || null,
        collectionSlug: form.collectionSlug || null, imageUrl: form.imageUrl || null,
        ctaLabel: form.ctaLabel || null, ctaUrl: form.ctaUrl || null,
      };
      if (!await succeeded(save(() => adminApi.marketingCampaigns.update(campaign.id, body)))) return;
    }
    if (step === 4 && !perCustomer) {
      if (!await succeeded(save(() => adminApi.marketingCampaigns.update(campaign.id, { audienceSources: audienceSources() })))) return;
    }
    if (step === 5) {
      if (!await succeeded(save(() => adminApi.marketingCampaigns.update(campaign.id, { trigger: triggerBody() })))) return;
    }
    existing.reload();
    go(next);
  };

  if (!canManage) return <PageShell title="Create campaign"><InlineAlert tone="error">You do not have permission to create campaigns.</InlineAlert></PageShell>;
  const loading = [options, templates].some((r) => r.status === 'loading') || (id && existing.status === 'loading');
  const failed = [options, templates, existing].find((r) => r.status === 'error');

  return (
    <PageShell
      title={campaign ? campaign.name : cartSection ? 'Set up cart reminders' : 'Create campaign'}
      description="Choose what to send, to whom, and when. You can review and send a test before anything goes to customers."
      actions={<Button variant="ghost" onClick={() => navigate(campaign && !cartSection ? `/messaging/campaigns/${campaign.id}` : sectionPath)}>Close</Button>}
    >
      <ol className="wizard-steps">
        {STEPS.map((label, i) => (
          <li key={label} className={`wizard-steps__item${i + 1 === step ? ' is-current' : ''}${i + 1 < step ? ' is-done' : ''}`}>
            <button type="button" disabled={!campaign || i + 1 > step} onClick={() => go(i + 1)}>
              <span className="wizard-steps__n">{i + 1}</span>{label}
            </button>
          </li>
        ))}
      </ol>

      {loading && <LoadingState label="Loading…" />}
      {failed && <ErrorState message={failed.error?.message} onRetry={failed.reload} />}
      {saveState.error && <InlineAlert tone="error">{saveState.error.message}</InlineAlert>}
      {notice && <InlineAlert tone="success">{notice}</InlineAlert>}
      {campaign && !editable && (
        <InlineAlert tone="warning">This campaign is {campaign.status.toLowerCase()}. Pause it before making changes.</InlineAlert>
      )}

      {!loading && !failed && (
        <div className="wizard-panel">
          {step === 1 && (
            <StepDetails form={form} set={set} types={types} disabled={!editable}
              onNext={() => saveStep(2)} busy={saveState.busy} />
          )}
          {step === 2 && (
            <StepChannels form={form} setForm={setForm} disabled={!editable} perCustomer={perCustomer}
              onBack={() => go(1)} onNext={() => go(3)} />
          )}
          {step === 3 && (
            <StepMessage form={form} set={set} setForm={setForm} type={type} disabled={!editable}
              templateChoices={templateChoices} collections={collections.data?.collections ?? []}
              onBack={() => go(2)} onNext={() => saveStep(4)} busy={saveState.busy} />
          )}
          {step === 4 && (
            <StepAudience form={form} setForm={setForm} perCustomer={perCustomer} disabled={!editable}
              lists={lists} segments={segments.data?.segments ?? []}
              onBack={() => go(3)} onNext={() => saveStep(5)} busy={saveState.busy} />
          )}
          {step === 5 && (
            <StepTrigger form={form} set={set} setForm={setForm} triggers={triggers} type={type} disabled={!editable}
              onBack={() => go(4)} onNext={() => saveStep(6)} busy={saveState.busy} />
          )}
          {step === 6 && campaign && (
            <StepReview campaign={campaign} perCustomer={perCustomer} canSend={canSend}
              lists={lists.data ?? []} segments={segments.data?.segments ?? []} types={types}
              onBack={() => go(5)} onNext={() => go(7)} />
          )}
          {step === 7 && campaign && (
            <StepActivate campaign={campaign} canSend={canSend} onBack={() => go(6)}
              onDone={(message) => navigate(cartSection ? sectionPath : `/messaging/campaigns/${campaign.id}`, { state: { notice: message } })} />
          )}
        </div>
      )}
    </PageShell>
  );
}

function StepNav({ onBack, onNext, nextLabel = 'Continue', nextDisabled, busy }) {
  return (
    <div className="wizard-nav">
      {onBack ? <Button variant="ghost" onClick={onBack}>Back</Button> : <span />}
      {onNext && <Button onClick={onNext} disabled={nextDisabled} busy={busy}>{nextLabel}</Button>}
    </div>
  );
}

function StepDetails({ form, set, types, disabled, onNext, busy }) {
  return (
    <>
      <h2 className="wizard-title">What is this campaign?</h2>
      <FormField id="c-name" label="Campaign name" value={form.name} onChange={set('name')} disabled={disabled}
        placeholder="e.g. The First Fire Launch" required />
      <p className="wizard-label">Campaign type</p>
      <div className="choice-grid">
        {types.map((t) => (
          <button key={t.key} type="button" disabled={disabled}
            className={`choice-card${form.campaignType === t.key ? ' is-selected' : ''}`}
            onClick={() => set('campaignType')(t.key)} aria-pressed={form.campaignType === t.key}>
            <span className="choice-card__title">{t.label}</span>
            <span className="choice-card__text">{t.description}</span>
          </button>
        ))}
      </div>
      <StepNav onNext={onNext} busy={busy} nextDisabled={disabled || form.name.trim().length < 2 || !form.campaignType} />
    </>
  );
}

function StepChannels({ form, setForm, disabled, onBack, onNext }) {
  const toggle = (channel) => setForm((f) => {
    const next = { ...f.channels };
    if (channel in next) delete next[channel]; else next[channel] = '';
    return { ...f, channels: next };
  });
  return (
    <>
      <h2 className="wizard-title">Where should it be sent?</h2>
      <div className="choice-grid choice-grid--two">
        {['WHATSAPP', 'EMAIL'].map((channel) => (
          <button key={channel} type="button" disabled={disabled}
            className={`choice-card${channel in form.channels ? ' is-selected' : ''}`}
            onClick={() => toggle(channel)} aria-pressed={channel in form.channels}>
            <span className="choice-card__title">{CHANNEL_LABEL[channel]}</span>
            <span className="choice-card__text">
              {channel === 'WHATSAPP' ? 'Sent on a template approved by Meta.' : 'Sent from marketing@ with an unsubscribe link.'}
            </span>
          </button>
        ))}
      </div>
      <p className="muted">Each customer receives it only on channels where their marketing preference is on.</p>
      <StepNav onBack={onBack} onNext={onNext} nextDisabled={!Object.keys(form.channels).length} />
    </>
  );
}

function StepMessage({ form, set, setForm, type, disabled, templateChoices, collections, onBack, onNext, busy }) {
  const fields = type?.contentFields ?? [];
  const setTemplate = (channel) => (value) => setForm((f) => ({ ...f, channels: { ...f.channels, [channel]: value || '' } }));
  const missingTemplate = Object.values(form.channels).some((v) => !v);
  return (
    <>
      <h2 className="wizard-title">What should it say?</h2>
      {Object.keys(form.channels).map((channel) => {
        const choices = templateChoices(channel);
        return (
          <div key={channel} className="wizard-block">
            <Select id={`tpl-${channel}`} label={`${CHANNEL_LABEL[channel]} template`} value={form.channels[channel]}
              onChange={setTemplate(channel)} disabled={disabled} includeBlank blankLabel="Choose a template…"
              options={choices.map((t) => [t.templateKey, templateLabel(t.templateKey)])} />
            {choices.length === 0 && (
              <InlineAlert tone="warning">
                No {CHANNEL_LABEL[channel]} marketing template is available yet. Add one under
                {channel === 'EMAIL' ? ' Email Templates' : ' WhatsApp Templates'}.
              </InlineAlert>
            )}
          </div>
        );
      })}

      {fields.includes('collection') && (
        <Select id="c-collection" label="Collection" value={form.collectionSlug} onChange={set('collectionSlug')} disabled={disabled}
          includeBlank blankLabel="Choose a collection…"
          options={collections.filter((c) => c.status === 'ACTIVE').map((c) => [c.slug, `${c.name} (${c.activeProductCount} products)`])} />
      )}
      {fields.includes('offer') && (
        <>
          <FormField id="c-offer" label="Headline" value={form.offerName} onChange={set('offerName')} disabled={disabled}
            placeholder="e.g. Diwali Sale — 20% off" />
          <FormField id="c-details" label="Details" value={form.offerDetails} onChange={set('offerDetails')} disabled={disabled}
            placeholder="e.g. On everything, until Sunday" />
        </>
      )}
      {(fields.includes('media') || fields.includes('collection')) && (
        <FormField id="c-image" label={fields.includes('collection') ? 'Image (optional — the collection photo is used otherwise)' : 'Image link (https://…)'}
          value={form.imageUrl} onChange={set('imageUrl')} disabled={disabled} placeholder="https://" />
      )}
      {fields.includes('cta') && (
        <div className="editor-form__grid">
          <FormField id="c-cta" label="Button text" value={form.ctaLabel} onChange={set('ctaLabel')} disabled={disabled} placeholder="Shop Now" />
          <FormField id="c-cta-url" label="Button link (optional)" value={form.ctaUrl} onChange={set('ctaUrl')} disabled={disabled}
            placeholder={fields.includes('collection') ? 'The collection page' : 'The store home page'} />
        </div>
      )}
      {!fields.length && <p className="muted">This campaign fills its message from each customer’s own cart — nothing else to add.</p>}
      <StepNav onBack={onBack} onNext={onNext} busy={busy} nextDisabled={disabled || missingTemplate} />
    </>
  );
}

function StepAudience({ form, setForm, perCustomer, disabled, lists, segments, onBack, onNext, busy }) {
  const confirmed = (lists.data ?? []).filter((l) => l.confirmed_at);
  const toggleList = (listId) => setForm((f) => ({
    ...f, listIds: f.listIds.includes(listId) ? f.listIds.filter((x) => x !== listId) : [...f.listIds, listId],
  }));
  const any = form.registered || form.segmentId || form.emailSubscribers || form.whatsappSubscribers || form.listIds.length;

  if (perCustomer) {
    return (
      <>
        <h2 className="wizard-title">Who receives it?</h2>
        <InlineAlert tone="info">Each customer who leaves items in their cart receives it — there is no list to choose.</InlineAlert>
        <StepNav onBack={onBack} onNext={onNext} busy={busy} />
      </>
    );
  }
  return (
    <>
      <h2 className="wizard-title">Who receives it?</h2>
      <p className="muted">Choose one or more. Anyone who appears in more than one is messaged once.</p>

      <label className="check-row">
        <input type="checkbox" checked={Boolean(form.registered)} disabled={disabled}
          onChange={(e) => setForm((f) => ({ ...f, registered: e.target.checked ? 'ALL' : null }))} />
        <span>Registered customers</span>
      </label>
      {form.registered && (
        <div className="check-row__detail">
          <Select id="a-registered" value={form.registered} disabled={disabled}
            onChange={(v) => setForm((f) => ({ ...f, registered: v || 'ALL' }))}
            options={Object.entries(REGISTERED_FILTER_LABEL)} />
        </div>
      )}

      <label className="check-row">
        <input type="checkbox" checked={Boolean(form.segmentId)} disabled={disabled || !segments.length}
          onChange={(e) => setForm((f) => ({ ...f, segmentId: e.target.checked ? segments[0]?.id || null : null }))} />
        <span>A customer segment {!segments.length && <span className="muted">(none created yet)</span>}</span>
      </label>
      {form.segmentId && (
        <div className="check-row__detail">
          <Select id="a-segment" value={form.segmentId} disabled={disabled}
            onChange={(v) => setForm((f) => ({ ...f, segmentId: v }))} options={segments.map((s) => [s.id, s.name])} />
        </div>
      )}

      <label className="check-row">
        <input type="checkbox" checked={form.emailSubscribers} disabled={disabled}
          onChange={(e) => setForm((f) => ({ ...f, emailSubscribers: e.target.checked }))} />
        <span>Email newsletter subscribers</span>
      </label>
      <label className="check-row">
        <input type="checkbox" checked={form.whatsappSubscribers} disabled={disabled}
          onChange={(e) => setForm((f) => ({ ...f, whatsappSubscribers: e.target.checked }))} />
        <span>WhatsApp subscribers</span>
      </label>

      <p className="wizard-label">Uploaded lists</p>
      {confirmed.map((l) => (
        <label key={l.id} className="check-row">
          <input type="checkbox" checked={form.listIds.includes(l.id)} disabled={disabled} onChange={() => toggleList(l.id)} />
          <span>{l.name} <span className="muted">({l.usable_contacts} contacts)</span></span>
        </label>
      ))}
      {!disabled && (
        <AudienceListUpload onConfirmed={(listId) => {
          lists.reload();
          setForm((f) => ({ ...f, listIds: [...new Set([...f.listIds, listId])] }));
        }} />
      )}
      <StepNav onBack={onBack} onNext={onNext} busy={busy} nextDisabled={disabled || !any} />
    </>
  );
}

function StepTrigger({ form, set, setForm, triggers, type, disabled, onBack, onNext, busy }) {
  const forCart = type?.key === 'ABANDONED_CART';
  // An abandoned-cart campaign is driven by carts; every other type is sent
  // now or at a chosen time (event triggers arrive in a later phase).
  const choices = triggers.filter((t) => (forCart ? t.key === 'cart.abandoned' : !t.perCustomer));
  const setCart = (k) => (v) => setForm((f) => ({ ...f, cart: { ...f.cart, [k]: v } }));
  // The clock is read once when the step opens, not on every render. The
  // server re-checks that a schedule is in the future when it is activated.
  const [openedAt] = useState(() => Date.now());
  const minTime = toLocalInput(new Date(openedAt + 5 * 60_000));
  const invalid = !form.triggerKey
    || (form.triggerKey === 'scheduled' && (!form.scheduledAt || new Date(form.scheduledAt).getTime() <= openedAt));

  return (
    <>
      <h2 className="wizard-title">When should it send?</h2>
      <div className="choice-grid choice-grid--two">
        {choices.map((t) => (
          <button key={t.key} type="button" disabled={disabled}
            className={`choice-card${form.triggerKey === t.key ? ' is-selected' : ''}`}
            onClick={() => set('triggerKey')(t.key)} aria-pressed={form.triggerKey === t.key}>
            <span className="choice-card__title">{t.label}</span>
            <span className="choice-card__text">{t.description}</span>
          </button>
        ))}
      </div>
      {form.triggerKey === 'scheduled' && (
        <div className="form-field">
          <label htmlFor="t-at">Send on</label>
          <input id="t-at" type="datetime-local" min={minTime} value={form.scheduledAt} disabled={disabled}
            onChange={(e) => set('scheduledAt')(e.target.value)} />
        </div>
      )}
      {form.triggerKey === 'cart.abandoned' && (
        <div className="editor-form__grid">
          <FormField id="t-delay" type="number" label="Remind after (hours)" value={form.cart.delayHours} onChange={setCart('delayHours')} disabled={disabled} />
          <FormField id="t-age" type="number" label="Skip carts older than (days)" value={form.cart.maxAgeDays} onChange={setCart('maxAgeDays')} disabled={disabled} />
          <FormField id="t-gap" type="number" label="At most one reminder per customer every (days)" value={form.cart.cooldownDays} onChange={setCart('cooldownDays')} disabled={disabled} />
          <FormField id="t-min" type="number" label="Only carts worth at least (₹)" value={form.cart.minCartRupees} onChange={setCart('minCartRupees')} disabled={disabled} />
          <FormField id="t-coupon" label="Coupon to mention (optional)" value={form.cart.couponCode} onChange={setCart('couponCode')} disabled={disabled} placeholder="An existing coupon code" />
        </div>
      )}
      <StepNav onBack={onBack} onNext={onNext} busy={busy} nextDisabled={disabled || invalid} />
    </>
  );
}

function StepReview({ campaign, perCustomer, canSend, lists, segments, types, onBack, onNext }) {
  const readiness = useApiResource(() => adminApi.marketingCampaigns.readiness(campaign.id));
  const preview = useApiResource(() => (perCustomer ? Promise.resolve(null) : adminApi.marketingCampaigns.audiencePreview(campaign.id)));
  const [test, setTest] = useState({ email: '', phone: '', contact: '' });
  const [sendTest, testState] = useMutation(() => adminApi.marketingCampaigns.test(campaign.id, perCustomer
    ? { contact: test.contact.trim() }
    : { email: test.email.trim() || null, phone: test.phone.trim() || null }));
  const [testResult, setTestResult] = useState(null);
  const typeLabel = types.find((t) => t.key === campaign.campaign_type)?.label || campaign.campaign_type;
  const people = preview.data?.people;

  return (
    <>
      <h2 className="wizard-title">Review</h2>
      <dl className="summary-list">
        <dt>Campaign</dt><dd>{campaign.name} · {typeLabel}</dd>
        <dt>Channels</dt><dd>{campaign.channels.map((c) => `${CHANNEL_LABEL[c.channel]} — ${templateLabel(c.templateKey)}`).join(', ') || '—'}</dd>
        <dt>Audience</dt><dd>{perCustomer ? 'Each customer with an abandoned cart' : describeAudience(campaign.audience_sources, lists, segments)}</dd>
        <dt>Trigger</dt><dd>{campaign.trigger?.label}{campaign.trigger_type === 'SCHEDULED' ? ` — ${formatDateTime(campaign.scheduled_at)}` : ''}</dd>
      </dl>

      {readiness.status === 'ready' && (readiness.data.ready
        ? <InlineAlert tone="success">Everything is set up correctly.</InlineAlert>
        : (
          <div className="inline-alert inline-alert--warning" role="status">
            <strong>Before you can activate:</strong>
            <ul>{readiness.data.blockers.map((b) => <li key={`${b.code}-${b.channel || ''}`}>{b.message}</li>)}</ul>
          </div>
        ))}

      {!perCustomer && (
        <>
          <p className="wizard-label">Audience</p>
          {preview.status === 'loading' && <LoadingState label="Checking the audience and preferences…" />}
          {preview.status === 'error' && <ErrorState message={preview.error?.message} onRetry={preview.reload} />}
          {people && (
            <StatStrip
              min={140}
              cards={[
                ...(people.registeredCustomers !== null ? [{ label: 'Registered customers', value: people.registeredCustomers }] : []),
                { label: 'WhatsApp eligible', value: people.whatsappEligible, tone: 'good' },
                { label: 'Email eligible', value: people.emailEligible, tone: 'good' },
                { label: 'Both', value: people.bothEligible },
                { label: 'Turned off', value: people.disabled, tone: people.disabled ? 'bad' : undefined },
                { label: `Messaged in last ${people.frequencyCapHours} h`, value: people.frequencyCapped ?? 0, tone: people.frequencyCapped ? 'bad' : undefined },
                ...(people.missingContact !== null ? [{ label: 'No contact details', value: people.missingContact }] : []),
                { label: 'Will receive it', value: people.finalSendable, tone: 'good' },
              ]}
            />
          )}
        </>
      )}

      {canSend && (
        <div className="wizard-block">
          <p className="wizard-label">Send a test first</p>
          {perCustomer ? (
            <FormField id="test-contact" label="Customer email or phone (their current cart is used)" value={test.contact}
              onChange={(v) => setTest((t) => ({ ...t, contact: v }))} />
          ) : (
            <div className="editor-form__grid">
              {campaign.channels.some((c) => c.channel === 'EMAIL') && (
                <FormField id="test-email" label="Your email" value={test.email} onChange={(v) => setTest((t) => ({ ...t, email: v }))} />
              )}
              {campaign.channels.some((c) => c.channel === 'WHATSAPP') && (
                <FormField id="test-phone" label="Your WhatsApp number" value={test.phone} onChange={(v) => setTest((t) => ({ ...t, phone: v }))} />
              )}
            </div>
          )}
          <Button variant="secondary" busy={testState.busy}
            disabled={perCustomer ? test.contact.trim().length < 3 : !(test.email.trim() || test.phone.trim())}
            onClick={() => sendTest().then(setTestResult).catch(() => {})}>Send test</Button>
          {testState.error && !testState.busy && <InlineAlert tone="error">{testState.error.message}</InlineAlert>}
          {testResult && (
            <InlineAlert tone="info">
              {testResult.results.map((r) => (
                <span key={r.channel}>
                  {CHANNEL_LABEL[r.channel]}: {r.queued || r.outcome === 'QUEUED' ? 'sent to the provider' : `not sent — ${r.message || r.reason || r.error}`}<br />
                </span>
              ))}
              {testResult.note}
            </InlineAlert>
          )}
        </div>
      )}
      <StepNav onBack={onBack} onNext={onNext} nextDisabled={readiness.status !== 'ready' || !readiness.data.ready} />
    </>
  );
}

function StepActivate({ campaign, canSend, onBack, onDone }) {
  const [activate, activateState] = useMutation(() => adminApi.marketingCampaigns.activate(campaign.id));
  const [resume, resumeState] = useMutation(() => adminApi.marketingCampaigns.resume(campaign.id));
  const kind = campaign.trigger_type;
  const summary = kind === 'SEND_NOW'
    ? 'It will start sending as soon as you activate it.'
    : kind === 'SCHEDULED'
      ? `It will send automatically on ${formatDateTime(campaign.scheduled_at)}.`
      : 'It will run automatically for every matching customer until you pause it.';

  return (
    <>
      <h2 className="wizard-title">{campaign.status === 'PAUSED' ? 'Resume campaign' : 'Activate campaign'}</h2>
      <p>{summary}</p>
      {!canSend && <InlineAlert tone="warning">You can prepare campaigns, but activating one needs send permission.</InlineAlert>}
      {(activateState.error || resumeState.error) && <InlineAlert tone="error">{(activateState.error || resumeState.error).message}</InlineAlert>}
      <div className="wizard-nav">
        <Button variant="ghost" onClick={onBack}>Back</Button>
        {campaign.status === 'DRAFT' && (
          <Button disabled={!canSend} busy={activateState.busy}
            onClick={() => activate().then((r) => onDone(r.status === 'SCHEDULED' ? 'Campaign scheduled.' : 'Campaign activated.')).catch(() => {})}>
            {kind === 'SEND_NOW' ? 'Activate and send' : kind === 'SCHEDULED' ? 'Schedule campaign' : 'Turn on campaign'}
          </Button>
        )}
        {campaign.status === 'PAUSED' && (
          <Button disabled={!canSend} busy={resumeState.busy}
            onClick={() => resume().then(() => onDone('Campaign resumed.')).catch(() => {})}>Resume campaign</Button>
        )}
      </div>
    </>
  );
}

export default CampaignBuilder;
