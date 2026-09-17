import { useId, useMemo, useState, useSyncExternalStore } from 'react';
import { adminApi } from '../../../api/adminApi.js';
import { useApiResource } from '../../../hooks/useApiResource.js';
import { Button } from '../../../components/ui/Button.jsx';
import { InlineAlert } from '../../../components/feedback/InlineAlert.jsx';
import { ErrorState } from '../../../components/feedback/ErrorState.jsx';
import { Skeleton } from '../../../components/feedback/Skeleton.jsx';
import { SortableList, DragHandle } from '../../../components/ui/SortableList.jsx';
import { useUnsavedGuard } from '../../../components/ui/rowHelpers.js';
import { LivePreview } from '../../../components/content/LivePreview.jsx';
import { PublishBar } from '../../../components/content/PublishBar.jsx';
import { TextField, Toggle, Segment, Errors, EntityLinkField, PathSuggestions } from '../header/HeaderEditors.jsx';
import { buildEntityIndex, same } from '../header/headerModel.js';
import * as A from './announcementModel.js';
import '../header/HeaderBuilder.css';
import './AnnouncementBuilder.css';

// CMS -> Experience -> Announcements.
//
// Left: the bar's messages in order (drag to reorder, switch on or off), the
// selected message's editor (its words, where it links, when it shows), and
// how the bar behaves. Right: the REAL storefront (LivePreview) with the
// unsaved bar, holding the message being edited on screen.
//
// Save draft writes the draft; Publish announcements makes it live.

export function AnnouncementBuilder({ canWrite, canPublish }) {
  const res = useApiResource(async () => {
    const [draft, pub] = await Promise.all([adminApi.content.announcements(), adminApi.content.published('announcements')]);
    return { draft, pub: pub.published?.snapshot || null };
  });
  const collections = useApiResource(() => adminApi.catalog.collections());
  const categories = useApiResource(() => adminApi.catalog.categories());
  const pages = useApiResource(() => adminApi.content.pages());

  // Outside the remounting inner tree: saving must not reset the selection,
  // the preview size or the notice.
  const [selectedKey, setSelectedKey] = useState(null);
  const [device, setDevice] = useState('desktop');
  const [resetKey, setResetKey] = useState(0);
  const [notice, setNotice] = useState(null);

  const pickers = useMemo(() => ({
    COLLECTION: {
      status: collections.status === 'ready' && categories.status === 'ready' ? 'ready' : 'loading',
      options: [
        ...(collections.data?.collections ?? []).filter((c) => c.status === 'ACTIVE').map((c) => [c.slug, c.name, c.id, 'COLLECTION', c.name]),
        ...(categories.data?.categories ?? []).filter((c) => c.status === 'ACTIVE').map((c) => [c.slug, `${c.name} (category)`, c.id, 'CATEGORY', c.name]),
      ],
    },
    CONTENT_PAGE: { status: pages.status, options: (pages.data?.pages ?? []).map((p) => [p.slug, p.title, p.id, 'PAGE', p.title]) },
  }), [collections.status, collections.data, categories.status, categories.data, pages.status, pages.data]);

  const entities = useMemo(() => (collections.status === 'ready' && categories.status === 'ready'
    ? buildEntityIndex({ collections: collections.data?.collections ?? [], categories: categories.data?.categories ?? [], pages: pages.data?.pages ?? [] })
    : null), [collections.status, collections.data, categories.status, categories.data, pages.data]);

  const activeSlugs = useMemo(
    () => (pickers.COLLECTION.status === 'ready' ? new Set(pickers.COLLECTION.options.map(([slug]) => slug)) : null),
    [pickers],
  );
  const archivedSlugs = useMemo(() => {
    if (collections.status !== 'ready' || categories.status !== 'ready') return null;
    return new Set([
      ...(collections.data?.collections ?? []).filter((c) => c.status !== 'ACTIVE').map((c) => c.slug),
      ...(categories.data?.categories ?? []).filter((c) => c.status !== 'ACTIVE').map((c) => c.slug),
    ]);
  }, [collections.status, collections.data, categories.status, categories.data]);

  if (res.status === 'loading') {
    return (
      <div className="hb" aria-busy="true">
        <div className="hb-top"><Skeleton height={20} width={220} /><Skeleton height={14} width={420} style={{ marginTop: 8 }} /></div>
        <div className="hb-layout">
          <div className="hb-col"><Skeleton lines={4} height={44} /></div>
          <div className="hb-col"><Skeleton height={420} /></div>
        </div>
      </div>
    );
  }
  if (res.status === 'error') return <ErrorState message={res.error?.message} onRetry={res.reload} />;

  return (
    <AnnouncementBuilderInner
      key={`${res.data.draft.document.workingVersion}.${resetKey}`}
      data={res.data} reload={res.reload}
      pickers={pickers} entities={entities} activeSlugs={activeSlugs} archivedSlugs={archivedSlugs}
      canWrite={canWrite} canPublish={canPublish}
      selectedKey={selectedKey} onSelect={setSelectedKey}
      device={device} onDevice={setDevice}
      onDiscard={() => { setNotice(null); setResetKey((k) => k + 1); }}
      notice={notice} setNotice={setNotice}
    />
  );
}

function AnnouncementBuilderInner({
  data, reload, pickers, entities, activeSlugs, archivedSlugs, canWrite, canPublish,
  selectedKey, onSelect, device, onDevice, onDiscard, notice, setNotice,
}) {
  const [messages, setMessages] = useState(() => data.draft.announcements.map(A.hydrate));
  const [settings, setSettings] = useState(() => A.hydrateSettings(data.draft.settings));
  const [base, setBase] = useState(() => ({
    byId: Object.fromEntries(data.draft.announcements.map((a) => [a.id, A.serialize(A.hydrate(a))])),
    order: data.draft.announcements.map((a) => a.id),
    settings: A.serializeSettings(A.hydrateSettings(data.draft.settings)),
  }));
  const [deleted, setDeleted] = useState([]);
  const [version, setVersion] = useState(data.draft.document.workingVersion);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [actionError, setActionError] = useState(null);
  const now = useSyncExternalStore(A.subscribeClock, A.clockNow, A.clockNow);

  // ---- dirty tracking + checks --------------------------------------------
  const dirty = (m) => m.isNew || !same(A.serialize(m), base.byId[m.id]);
  const orderDirty = !same(
    messages.filter((m) => !m.isNew).map((m) => m.id),
    base.order.filter((id) => !deleted.includes(id)),
  );
  const settingsDirty = !same(A.serializeSettings(settings), base.settings);
  const dirtyCount = messages.filter(dirty).length + deleted.length + (orderDirty ? 1 : 0) + (settingsDirty ? 1 : 0);
  const anyDirty = dirtyCount > 0;
  useUnsavedGuard(anyDirty);

  const checks = Object.fromEntries(messages.map((m) => [m._k, A.validate(m, entities)]));
  const settingsErrors = A.validateSettings(settings);
  const problemCount = Object.values(checks).reduce((n, c) => n + c.errors.length, 0) + settingsErrors.length;

  const current = messages.find((m) => m._k === selectedKey) || messages[0] || null;
  const patch = (next) => setMessages((cur) => cur.map((m) => (m._k === next._k ? next : m)));

  // Rebuilt every render; LivePreview only posts when its content changes.
  const previewMessage = A.previewMessage({ messages, settings, current, entities, now });

  // ---- local changes -------------------------------------------------------
  const addMessage = () => {
    const m = A.newMessage();
    setMessages((cur) => [...cur, m]);
    onSelect(m._k);
  };
  const removeMessage = (m) => {
    if (!window.confirm(`Remove “${A.messageTitle(m)}” from the bar? It disappears from the website when you publish.`)) return;
    setMessages((cur) => cur.filter((x) => x._k !== m._k));
    if (!m.isNew) setDeleted((d) => [...d, m.id]);
    onSelect(null);
  };

  // ---- save draft ----------------------------------------------------------
  const save = async () => {
    setActionError(null); setNotice(null); setSaving(true);
    let v = version;
    const working = [...messages];
    // Deleting keeps the others' order; new messages are added at the end.
    let serverOrder = base.order.filter((id) => !deleted.includes(id));
    try {
      for (const id of deleted) {
        const r = await adminApi.content.deleteAnnouncement(id, v);
        v = r.document.workingVersion;
        setDeleted((d) => d.filter((x) => x !== id));
      }
      for (let i = 0; i < working.length; i += 1) {
        const m = working[i];
        if (!dirty(m)) continue;
        const r = await adminApi.content.upsertAnnouncement({ ...A.serialize(m), expectedVersion: v });
        v = r.document.workingVersion;
        serverOrder = r.announcements.map((a) => a.id);
        const server = r.announcements.find((a) => a.announcementKey === m.announcementKey);
        // _k stays the same so the list and the selection do not jump.
        const saved = { ...A.hydrate(server), _k: m._k };
        working[i] = saved;
        setMessages((cur) => cur.map((x) => (x._k === m._k ? saved : x)));
        setBase((b) => ({ ...b, byId: { ...b.byId, [saved.id]: A.serialize(saved) } }));
      }
      const wanted = working.map((m) => m.id);
      if (!same(wanted, serverOrder)) {
        const r = await adminApi.content.reorderAnnouncements(wanted, v);
        v = r.document.workingVersion;
      }
      setBase((b) => ({ ...b, order: wanted }));
      if (settingsDirty) {
        const next = A.serializeSettings(settings);
        const r = await adminApi.content.setAnnouncementSettings(next, v);
        v = r.document.workingVersion;
        setBase((b) => ({ ...b, settings: next }));
      }
      setVersion(v);
      setNotice('Draft saved. Customers still see the published bar until you publish.');
      reload();
    } catch (err) {
      // Everything saved before the failure is kept; the rest stays to fix and save again.
      setVersion(v);
      setActionError(err);
    } finally {
      setSaving(false);
    }
  };

  // ---- publish -------------------------------------------------------------
  const doc = data.draft.document;
  const publish = async () => {
    setActionError(null); setNotice(null); setPublishing(true);
    try {
      await adminApi.content.publish('announcements', doc.workingVersion);
      setNotice('Published. The bar on the website now matches this draft.');
      reload();
    } catch (err) {
      setActionError(err);
    } finally {
      setPublishing(false);
    }
  };

  const unpublished = A.unpublished(messages, settings, data.pub) || messages.some((m) => m.isNew);
  const status = anyDirty ? { tone: 'warn', label: `${dirtyCount} unsaved change${dirtyCount === 1 ? '' : 's'}` }
    : unpublished ? { tone: 'info', label: 'Saved draft — not published' }
      : { tone: 'good', label: 'Live — matches the website' };

  return (
    <div className="hb ab">
      <PathSuggestions pickers={pickers} />
      <div className="hb-top">
        <div className="hb-top__text">
          <h2 className="hb-top__title">Announcement bar</h2>
          <ol className="hb-steps" aria-label="How it works">
            <li><span>1</span>Pick a message</li>
            <li><span>2</span>Edit — the preview updates as you type</li>
            <li className={anyDirty ? 'hb-steps__now' : ''}><span>3</span>Save draft</li>
            <li className={!anyDirty && unpublished ? 'hb-steps__now' : ''}><span>4</span>Publish — customers see it</li>
          </ol>
        </div>
        <div className="hb-top__actions">
          <span className={`hb-status hb-status--${status.tone}`} role="status">{status.label}</span>
          {canWrite && <Button variant="secondary" disabled={!anyDirty || saving} onClick={() => { if (window.confirm('Discard all unsaved changes to the bar?')) onDiscard(); }}>Discard</Button>}
          {canWrite && <Button busy={saving} disabled={!anyDirty || problemCount > 0} onClick={save}>Save draft</Button>}
          {canPublish && (
            <Button variant="success" busy={publishing} disabled={anyDirty || !unpublished} onClick={publish} title={anyDirty ? 'Save your changes first' : undefined}>
              Publish announcements
            </Button>
          )}
        </div>
      </div>

      {problemCount > 0 && <InlineAlert tone="warning">{problemCount} problem{problemCount === 1 ? '' : 's'} to fix before saving — messages with a red number need attention.</InlineAlert>}
      {actionError && <InlineAlert tone="error">{actionError.message}</InlineAlert>}
      {notice && !actionError && !anyDirty && <InlineAlert tone="success">{notice}</InlineAlert>}

      <div className="hb-layout">
        <div className="hb-col hb-col--edit">
          <section className="hb-panel" aria-labelledby="ab-messages-title">
            <div className="hb-panel__head">
              <h3 id="ab-messages-title" className="hb-panel__title">Messages, in order</h3>
              {messages.length > 1 && <span className="hb-panel__hint">Drag to reorder</span>}
            </div>
            {messages.length === 0 && <p className="hb-rows__empty">No messages — the bar is hidden on the website.</p>}
            <SortableList
              label="Announcement messages"
              items={messages}
              getKey={(m) => m._k}
              disabled={!canWrite}
              onReorder={setMessages}
              renderItem={(m, i, { handleProps }) => {
                const on = current?._k === m._k;
                const state = A.messageState(m, data.pub, now);
                const [tone, label] = A.STATE_PILL[state];
                const errs = checks[m._k].errors.length;
                const title = A.messageTitle(m);
                return (
                  <div className={`hb-item${on ? ' hb-item--active' : ''}${!m.enabled ? ' hb-item--off' : ''}`}>
                    <DragHandle {...handleProps} disabled={!canWrite} />
                    <button type="button" className="hb-item__main" aria-current={on || undefined} onClick={() => onSelect(m._k)}>
                      <span className="hb-item__label">{title}</span>
                      <span className="hb-item__meta">
                        {A.messageMeta(m, entities)}
                        {dirty(m) ? <span className="hb-dot" title="Unsaved changes" /> : null}
                      </span>
                    </button>
                    {errs > 0 && <span className="hb-item__errors" title={`${errs} problem(s)`}>{errs}</span>}
                    <span className={`hb-pill hb-pill--${tone} hb-pill--compact`}>{label}</span>
                    {canWrite && (
                      <button type="button" className="hb-icon-btn" aria-pressed={m.enabled}
                        aria-label={m.enabled ? `Hide ${title}` : `Show ${title}`}
                        onClick={() => patch({ ...m, enabled: !m.enabled })}>
                        {m.enabled ? <EyeIcon /> : <EyeOffIcon />}
                      </button>
                    )}
                  </div>
                );
              }}
            />
            {canWrite && <button type="button" className="hb-add" onClick={addMessage}>+ Add message</button>}
            {orderDirty && <p className="hb-panel__note">Order changed — save to keep it.</p>}
          </section>

          {current && (
            <MessageEditor
              key={current._k}
              message={current}
              onChange={patch}
              errors={checks[current._k].errors}
              warnings={checks[current._k].warnings}
              state={A.messageState(current, data.pub, now)}
              canWrite={canWrite}
              pickers={pickers} entities={entities} activeSlugs={activeSlugs} archivedSlugs={archivedSlugs}
              onRemove={() => removeMessage(current)}
            />
          )}

          <BarSettings settings={settings} onChange={setSettings} errors={settingsErrors} canWrite={canWrite} />
        </div>

        <div className="hb-col hb-col--preview">
          <div className="hb-preview-sticky">
            <LivePreview
              title="Announcement bar preview"
              height={200}
              message={previewMessage}
              device={device}
              onDeviceChange={onDevice}
              devices={['desktop', 'tablet', 'mobile']}
            />
            <div className="hb-preview-foot">
              <span>{A.previewCaption(current, now)}</span>
              <span>Colours come from the site theme (Campaigns)</span>
            </div>
          </div>
        </div>
      </div>

      <details className="hb-history">
        <summary>Version history &amp; rollback</summary>
        <PublishBar scope="announcements" doc={doc} canPublish={canPublish} onDone={reload} />
      </details>
    </div>
  );
}

function MessageEditor({ message, onChange, errors, warnings, state, canWrite, pickers, entities, activeSlugs, archivedSlugs, onRemove }) {
  const disabled = !canWrite;
  const set = (part) => onChange({ ...message, ...part });
  const startId = useId();
  const endId = useId();
  const [tone, label] = A.STATE_PILL[state];
  return (
    <section className="hb-panel hb-editor" aria-labelledby="ab-editor-title">
      <div className="hb-panel__head">
        <h3 id="ab-editor-title" className="hb-panel__title">Message</h3>
        <span className={`hb-pill hb-pill--${tone}`}>{label}</span>
      </div>

      <Toggle checked={message.enabled} disabled={disabled} label="Show in the bar" onChange={(v) => set({ enabled: v })} />
      <Errors errors={errors} />
      {warnings.map((w) => <p key={w} className="hb-field__hint hb-field__hint--warn">{w}</p>)}

      <div className="hb-grid">
        <div className="hb-grid__full">
          <TextField label="Message" multiline value={message.text} max={A.LIMITS.text} disabled={disabled} invalid={!message.text.trim()}
            placeholder="Free shipping on all orders" onChange={(v) => set({ text: v })}
            hint="One short line. The whole message is the link, when it has one." />
        </div>
        <div className="hb-grid__full hb-grid">
          <EntityLinkField
            purpose="message"
            optional
            row={message.link}
            onPatch={(p) => set({ link: { ...message.link, ...p } })}
            pickers={pickers} entities={entities} activeSlugs={activeSlugs} archivedSlugs={archivedSlugs}
            disabled={disabled} placeholder="/collections/… or https://"
          />
        </div>
      </div>

      <fieldset className="hb-fieldset ab-set">
        <legend>When it shows (optional)</legend>
        <div className="ab-two">
          <div className="hb-field">
            <label htmlFor={startId}>From</label>
            <input id={startId} className="hb-input" type="datetime-local" value={message.startsAt} disabled={disabled}
              onChange={(e) => set({ startsAt: e.target.value })} />
          </div>
          <div className="hb-field">
            <label htmlFor={endId}>Until</label>
            <input id={endId} className={`hb-input${message.startsAt && message.expiresAt && message.expiresAt <= message.startsAt ? ' hb-input--invalid' : ''}`}
              type="datetime-local" value={message.expiresAt} min={message.startsAt || undefined} disabled={disabled}
              onChange={(e) => set({ expiresAt: e.target.value })} />
          </div>
        </div>
        <p className="hb-field__hint">Empty: it shows as soon as it is published and stays until you change it. Times are your computer’s time zone.</p>
      </fieldset>

      {canWrite && (
        <div className="hb-editor__foot">
          <button type="button" className="hb-danger-link" onClick={onRemove}>Remove this message</button>
        </div>
      )}
    </section>
  );
}

function BarSettings({ settings, onChange, errors, canWrite }) {
  const disabled = !canWrite;
  const set = (part) => onChange({ ...settings, ...part });
  return (
    <section className="hb-panel ab-settings" aria-labelledby="ab-settings-title">
      <div className="hb-panel__head">
        <h3 id="ab-settings-title" className="hb-panel__title">How the bar behaves</h3>
      </div>
      <Errors errors={errors} />
      <Segment label="Next message every" value={String(settings.autoplaySeconds)} disabled={disabled}
        options={A.AUTOPLAY_CHOICES.map((n) => [String(n), `${n} s`])} onChange={(v) => set({ autoplaySeconds: Number(v) })} />
      <p className="hb-field__hint">It pauses while a visitor points at the bar.</p>
      <Toggle checked={settings.showClock} disabled={disabled} label="Show the clock (large screens)" onChange={(v) => set({ showClock: v })} />
      <Toggle checked={settings.dismissible} disabled={disabled} label="Visitors can close the bar"
        hint="A closed bar stays closed in that visitor’s browser." onChange={(v) => set({ dismissible: v })} />
      {settings.dismissible && (
        <Toggle checked={settings.showAgain} disabled={disabled}
          label="Show the bar again to everyone who closed it"
          hint="Use it for news everyone should see. It happens when you publish."
          onChange={(v) => set({ showAgain: v, nextDismissVersion: v ? `v${Date.now().toString(36)}` : null })} />
      )}
    </section>
  );
}

const EyeIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" /><circle cx="12" cy="12" r="3" /></svg>
);
const EyeOffIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 19C5 19 1 12 1 12a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M1 1l22 22" /></svg>
);

export default AnnouncementBuilder;
