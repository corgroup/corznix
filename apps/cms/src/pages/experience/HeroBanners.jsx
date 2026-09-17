import { useId, useMemo, useState, useSyncExternalStore } from 'react';
import { adminApi } from '../../api/adminApi.js';
import { useApiResource } from '../../hooks/useApiResource.js';
import { Button } from '../../components/ui/Button.jsx';
import { InlineAlert } from '../../components/feedback/InlineAlert.jsx';
import { ErrorState } from '../../components/feedback/ErrorState.jsx';
import { Skeleton } from '../../components/feedback/Skeleton.jsx';
import { MediaPicker } from '../../components/media/MediaPicker.jsx';
import { SortableList, DragHandle } from '../../components/ui/SortableList.jsx';
import { useUnsavedGuard } from '../../components/ui/rowHelpers.js';
import { LivePreview } from '../../components/content/LivePreview.jsx';
import { TextField, Toggle, Segment, Errors } from './header/HeaderEditors.jsx';
import { same } from './header/headerModel.js';
import * as M from './heroModel.js';
import './header/HeaderBuilder.css';
import './HeroBanners.css';

// CMS -> Experience -> Homepage -> Hero slides.
//
// Left: the slides in order (drag to reorder) and the selected slide's editor
// — desktop and phone pictures, copy and button, where the text sits on each
// kind of screen, text colour and shade, how long it shows, and its dates.
// Right: the REAL storefront hero (LivePreview) showing the unsaved edits, on
// desktop, tablet or phone, held on the slide being edited.
//
// Slides have no draft: saving a switched-on slide puts it on the website
// (within its dates). Everything unsaved is marked, and leaving asks first.

export function HeroBanners({ canWrite }) {
  const res = useApiResource(() => adminApi.content.heroBanners());
  const collections = useApiResource(() => adminApi.catalog.collections());
  const pages = useApiResource(() => adminApi.content.pages());
  const [device, setDevice] = useState('desktop');
  const [selectedKey, setSelectedKey] = useState(null);
  const [resetKey, setResetKey] = useState(0);
  const pathListId = useId();

  const paths = useMemo(() => [
    ...(collections.data?.collections ?? []).filter((c) => c.status === 'ACTIVE').map((c) => [`/collections/${c.slug}`, c.name]),
    ...(pages.data?.pages ?? []).map((p) => [`/pages/${p.slug}`, p.title]),
    ['/collections', 'All collections'], ['/search', 'Search'],
  ], [collections.data, pages.data]);

  if (res.status === 'loading') {
    return (
      <div className="hb" aria-busy="true">
        <div className="hb-top"><Skeleton height={20} width={180} /><Skeleton height={14} width={420} style={{ marginTop: 8 }} /></div>
        <div className="hb-layout">
          <div className="hb-col"><Skeleton lines={4} height={44} /></div>
          <div className="hb-col"><Skeleton height={560} /></div>
        </div>
      </div>
    );
  }
  if (res.status === 'error') return <ErrorState message={res.error?.message} onRetry={res.reload} />;

  return (
    <HeroBuilderInner
      key={resetKey}
      initial={res.data.banners}
      canWrite={canWrite}
      paths={paths}
      pathListId={pathListId}
      device={device}
      onDevice={setDevice}
      selectedKey={selectedKey}
      onSelect={setSelectedKey}
      onReset={() => { setResetKey((k) => k + 1); res.reload(); }}
    />
  );
}

function HeroBuilderInner({ initial, canWrite, paths, pathListId, device, onDevice, selectedKey, onSelect, onReset }) {
  const [slides, setSlides] = useState(() => initial.map(M.hydrate));
  // The saved version of each slide and the saved order, to tell what is unsaved.
  const [base, setBase] = useState(() => ({
    byId: Object.fromEntries(initial.map((b) => [b.id, M.hydrate(b)])),
    order: initial.map((b) => b.id),
  }));
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const now = useSyncExternalStore(M.subscribeClock, M.clockNow, M.clockNow);

  const dirty = (s) => s.isNew || !same(M.serialize(s), M.serialize(base.byId[s.id]));
  const savedOrder = slides.filter((s) => !s.isNew).map((s) => s.id);
  const orderDirty = !same(savedOrder, base.order);
  const dirtyCount = slides.filter(dirty).length + (orderDirty ? 1 : 0);
  useUnsavedGuard(dirtyCount > 0);

  const checks = Object.fromEntries(slides.map((s) => [s._k, M.validate(s)]));
  const current = slides.find((s) => s._k === selectedKey) || slides[0] || null;
  const patch = (next) => setSlides((cur) => cur.map((s) => (s._k === next._k ? next : s)));

  // Rebuilt every render; LivePreview only posts when its content changes.
  const previewMessage = M.previewMessage(slides, current, now);

  const run = async (name, fn) => {
    setBusy(name); setError(null); setNotice(null);
    try { await fn(); } catch (err) { setError(err); } finally { setBusy(null); }
  };

  const addSlide = () => {
    const s = M.newSlide();
    setSlides((cur) => [...cur, s]);
    onSelect(s._k);
  };

  const saveSlide = (s) => run('save', async () => {
    const body = M.serialize(s);
    const saved = s.isNew ? await adminApi.content.createHeroBanner(body) : await adminApi.content.updateHeroBanner(s.id, body);
    // _k stays the same so the list and the selection do not jump.
    const next = { ...M.hydrate(saved), _k: s._k };
    setSlides((cur) => cur.map((x) => (x._k === s._k ? next : x)));
    setBase((b) => ({ byId: { ...b.byId, [saved.id]: next }, order: s.isNew ? [...b.order, saved.id] : b.order }));
    const state = M.slideState(next, Date.now());
    setNotice(state === 'live' ? 'Saved — this slide is on the website now.' : `Saved. ${M.stateNote(next, state)}`);
  });

  const undoSlide = (s) => {
    if (s.isNew) {
      setSlides((cur) => cur.filter((x) => x._k !== s._k));
      onSelect(null);
      return;
    }
    patch({ ...base.byId[s.id], _k: s._k });
  };

  const duplicateSlide = (s) => run('duplicate', async () => {
    const copy = M.hydrate(await adminApi.content.duplicateHeroBanner(s.id));
    setSlides((cur) => [...cur, copy]);
    setBase((b) => ({ byId: { ...b.byId, [copy.id]: copy }, order: [...b.order, copy.id] }));
    onSelect(copy._k);
    setNotice('Copied. The copy is switched off until you switch it on and save.');
  });

  const deleteSlide = (s) => {
    if (!window.confirm(`Delete “${M.slideTitle(s)}”? ${s.isNew ? '' : 'It is removed from the website at once. '}This cannot be undone.`)) return;
    run('delete', async () => {
      if (!s.isNew) await adminApi.content.deleteHeroBanner(s.id);
      setSlides((cur) => cur.filter((x) => x._k !== s._k));
      setBase((b) => {
        const byId = { ...b.byId };
        delete byId[s.id];
        return { byId, order: b.order.filter((id) => id !== s.id) };
      });
      onSelect(null);
      setNotice('Slide deleted.');
    });
  };

  const saveOrder = () => run('order', async () => {
    await adminApi.content.reorderHeroBanners(savedOrder);
    setBase((b) => ({ ...b, order: savedOrder }));
    setNotice('Order saved — the website shows the slides in this order now.');
  });

  const importCurrent = () => run('import', async () => {
    const list = (await adminApi.content.importHeroBanners()).banners.map(M.hydrate);
    setSlides(list);
    setBase({ byId: Object.fromEntries(list.map((h) => [h.id, h])), order: list.map((h) => h.id) });
    onSelect(list[0]?._k ?? null);
    setNotice(`The current hero is now ${list.length} editable slide${list.length === 1 ? '' : 's'}. ${list.length === 1 ? 'It is' : 'They are'} switched on, so the homepage looks exactly as before.`);
  });

  const status = dirtyCount > 0
    ? { tone: 'warn', label: `${dirtyCount} unsaved change${dirtyCount === 1 ? '' : 's'}` }
    : { tone: 'good', label: 'Saved — switched-on slides are live' };

  return (
    <div className="hb hero-b">
      <datalist id={pathListId}>
        {paths.map(([p, name]) => <option key={p} value={p}>{name}</option>)}
      </datalist>

      <div className="hb-top">
        <div className="hb-top__text">
          <h2 className="hb-top__title">Hero slides</h2>
          <p className="hb-top__desc">
            The full-width slides at the top of the homepage. There is no draft here: a switched-on slide is on the website as soon as it is saved, within its dates.
          </p>
        </div>
        <div className="hb-top__actions">
          <span className={`hb-status hb-status--${status.tone}`} role="status">{status.label}</span>
          {canWrite && (
            <Button variant="secondary" disabled={dirtyCount === 0 || Boolean(busy)}
              onClick={() => { if (window.confirm('Discard all unsaved hero slide changes?')) onReset(); }}>
              Discard all
            </Button>
          )}
        </div>
      </div>

      {error && <InlineAlert tone="error">{error.message}</InlineAlert>}
      {notice && !error && <InlineAlert tone="success">{notice}</InlineAlert>}

      <div className="hb-layout">
        <div className="hb-col hb-col--edit">
          <section className="hb-panel" aria-labelledby="hero-slides-title">
            <div className="hb-panel__head">
              <h3 id="hero-slides-title" className="hb-panel__title">Slides, in order</h3>
              {slides.length > 1 && <span className="hb-panel__hint">Drag to reorder</span>}
            </div>

            {slides.length === 0 ? (
              <div className="hbn-empty">
                <p><strong>No slides yet.</strong> The homepage shows its built-in hero: two videos with fixed text.</p>
                {canWrite && (
                  <p>
                    Start from it to edit its text, pictures and timing — the homepage looks the same until you change something — or add a new slide.
                  </p>
                )}
                {canWrite && (
                  <div className="hbn-empty__actions">
                    <Button busy={busy === 'import'} disabled={Boolean(busy)} onClick={importCurrent}>Start from the current hero</Button>
                  </div>
                )}
              </div>
            ) : (
              <SortableList
                label="Hero slides"
                items={slides}
                getKey={(s) => s._k}
                disabled={!canWrite || Boolean(busy)}
                onReorder={setSlides}
                renderItem={(s, i, { handleProps }) => {
                  const state = M.slideState(s, now);
                  const [tone, label] = M.STATE_PILL[state];
                  const errs = checks[s._k].errors.length;
                  const on = current?._k === s._k;
                  return (
                    <div className={`hb-item${on ? ' hb-item--active' : ''}${state !== 'live' ? ' hb-item--off' : ''}`}>
                      <DragHandle {...handleProps} disabled={!canWrite} />
                      <span className="hbn-thumb" aria-hidden="true">
                        {s.mediaUrl
                          ? (s.mediaType === 'video'
                            ? <video src={s.mediaUrl} muted preload="metadata" />
                            : <img src={s.mediaUrl} alt="" loading="lazy" />)
                          : null}
                      </span>
                      <button type="button" className="hb-item__main" aria-current={on || undefined} onClick={() => onSelect(s._k)}>
                        <span className="hb-item__label">{M.slideTitle(s, i)}</span>
                        <span className="hb-item__meta">
                          {M.slideMeta(s, state)}
                          {dirty(s) ? <span className="hb-dot" title="Unsaved changes" /> : null}
                        </span>
                      </button>
                      {errs > 0 && <span className="hb-item__errors" title={`${errs} problem(s)`}>{errs}</span>}
                      <span className={`hb-pill hb-pill--${tone} hb-pill--compact`}>{label}</span>
                    </div>
                  );
                }}
              />
            )}

            {canWrite && <button type="button" className="hb-add" disabled={Boolean(busy)} onClick={addSlide}>+ Add slide</button>}
            {orderDirty && (
              <div className="hbn-order">
                <p className="hb-panel__note">Order changed — the website keeps the old order until you save it.</p>
                {canWrite && <Button variant="secondary" busy={busy === 'order'} disabled={Boolean(busy)} onClick={saveOrder}>Save order</Button>}
              </div>
            )}
          </section>

          {current && (
            <SlideEditor
              key={current._k}
              slide={current}
              onChange={patch}
              errors={checks[current._k].errors}
              now={now}
              canWrite={canWrite}
              dirty={dirty(current)}
              busy={busy}
              pathListId={pathListId}
              onSave={() => saveSlide(current)}
              onUndo={() => undoSlide(current)}
              onDuplicate={() => duplicateSlide(current)}
              onDelete={() => deleteSlide(current)}
            />
          )}
        </div>

        <div className="hb-col hb-col--preview">
          <div className="hb-preview-sticky">
            <LivePreview
              title="Hero preview"
              message={previewMessage}
              device={device}
              onDeviceChange={onDevice}
              devices={['desktop', 'tablet', 'mobile']}
              height={560}
            />
            <div className="hb-preview-foot">
              <span>{M.previewCaption(current, now)}</span>
              <span>Phones use the phone picture and phone text position</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PositionPicker({ label, value, onChange, disabled }) {
  return (
    <div className="hb-field">
      <span className="hb-field__label">{label}</span>
      <div className="hbn-pos" role="radiogroup" aria-label={label}>
        {M.POSITIONS.map((p) => (
          <button key={p} type="button" role="radio" aria-checked={value === p} aria-label={M.POSITION_LABEL[p]}
            title={M.POSITION_LABEL[p]} disabled={disabled}
            className={`hbn-pos__cell${value === p ? ' hbn-pos__cell--on' : ''}`} onClick={() => onChange(p)}>
            <span aria-hidden="true" />
          </button>
        ))}
      </div>
      <p className="hb-field__hint">{M.POSITION_LABEL[value]}</p>
    </div>
  );
}

function ShadeField({ label, value, onChange, disabled }) {
  const id = useId();
  return (
    <div className="hb-field">
      <div className="hb-field__label-row">
        <label htmlFor={id}>{label}</label>
        <span className="hb-counter">{value}%</span>
      </div>
      <input id={id} className="hbn-range" type="range" min={0} max={90} step={5} value={value} disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))} />
      <p className="hb-field__hint">Keeps the text readable on a busy or bright picture. 0% is no shade.</p>
    </div>
  );
}

function SlideEditor({ slide, onChange, errors, now, canWrite, dirty, busy, pathListId, onSave, onUndo, onDuplicate, onDelete }) {
  const disabled = !canWrite;
  const set = (part) => onChange({ ...slide, ...part });
  const state = M.slideState(slide, now);
  const [tone, label] = M.STATE_PILL[state];
  const linkId = useId();
  const startId = useId();
  const endId = useId();
  const hasVideo = slide.mediaType === 'video' || slide.mobileMediaType === 'video';
  const media = (key) => ({ mediaId, url }) => set({
    [`${key}Id`]: mediaId || null, [`${key}Url`]: url || null, [`${key}Type`]: url ? M.guessMediaType(url) : null,
  });

  return (
    <section className="hb-panel hb-editor" aria-labelledby="hero-editor-title">
      <div className="hb-panel__head">
        <h3 id="hero-editor-title" className="hb-panel__title">{M.slideTitle(slide)}</h3>
        <span className={`hb-pill hb-pill--${tone}`}>{label}</span>
      </div>

      <Toggle checked={slide.active} disabled={disabled} label="Switched on — show on the website" onChange={(v) => set({ active: v })} />
      {state !== 'live' && <p className="hb-field__hint hb-field__hint--warn">{M.stateNote(slide, state)}</p>}
      <Errors errors={errors} />

      <div className="hb-grid">
        <div className="hb-grid__full hbn-media">
          <MediaPicker
            label="Desktop and tablet picture or video"
            hint="Wide: 1920 × 1080 px. JPG, PNG, WebP or MP4. Max 5MB."
            disabled={disabled}
            value={slide.mediaId ? { mediaId: slide.mediaId, url: slide.mediaUrl } : null}
            onChange={media('media')}
          />
          <MediaPicker
            label="Phone picture or video (optional)"
            hint="Tall: 1080 × 1920 px. Empty: the desktop one is used, cropped to fit the phone."
            disabled={disabled}
            value={slide.mobileMediaId ? { mediaId: slide.mobileMediaId, url: slide.mobileMediaUrl } : null}
            onChange={media('mobileMedia')}
          />
        </div>
        <div className="hb-grid__full">
          <TextField label="Describe the picture" value={slide.altText} max={M.LIMITS.altText} disabled={disabled}
            hint="Read out by screen readers. Leave empty when the picture is only decoration." onChange={(v) => set({ altText: v })} />
        </div>
        <div className="hb-grid__full">
          <TextField label="Title" value={slide.title} max={M.LIMITS.title} disabled={disabled} onChange={(v) => set({ title: v })} />
        </div>
        <div className="hb-grid__full">
          <TextField label="Line under the title" value={slide.subtitle} max={M.LIMITS.subtitle} disabled={disabled} multiline onChange={(v) => set({ subtitle: v })} />
        </div>
        <TextField label="Button text" value={slide.ctaLabel} max={M.LIMITS.ctaLabel} disabled={disabled}
          hint="Leave the text and link empty for no button." onChange={(v) => set({ ctaLabel: v })} />
        <div className="hb-field">
          <label htmlFor={linkId}>Button link</label>
          <input id={linkId} className={`hb-input${M.linkProblem(slide) ? ' hb-input--invalid' : ''}`} list={pathListId}
            value={slide.ctaHref} maxLength={M.LIMITS.ctaHref} placeholder="/collections/new-in" disabled={disabled}
            onChange={(e) => set({ ctaHref: e.target.value })} />
          <p className="hb-field__hint">A page on this website, starting with “/”. Start typing to pick one.</p>
        </div>
      </div>

      <fieldset className="hb-fieldset hbn-set">
        <legend>Text position and look</legend>
        <div className="hbn-two">
          <PositionPicker label="On desktops and tablets" value={slide.textPosition} disabled={disabled} onChange={(v) => set({ textPosition: v })} />
          <PositionPicker label="On phones" value={slide.mobileTextPosition} disabled={disabled} onChange={(v) => set({ mobileTextPosition: v })} />
        </div>
        <Segment label="Text colour" value={slide.textTheme} disabled={disabled}
          options={[['LIGHT', 'White text'], ['DARK', 'Dark text']]} onChange={(v) => set({ textTheme: v })} />
        <ShadeField label={slide.textTheme === 'DARK' ? 'Light shade behind the text' : 'Dark shade behind the text'}
          value={slide.overlay} disabled={disabled} onChange={(v) => set({ overlay: v })} />
      </fieldset>

      <fieldset className="hb-fieldset hbn-set">
        <legend>Timing</legend>
        <Segment label="Show this slide for" value={String(slide.durationSeconds)} disabled={disabled}
          options={M.DURATIONS.map((n) => [String(n), `${n} seconds`])} onChange={(v) => set({ durationSeconds: Number(v) })} />
        <p className="hb-field__hint">
          {hasVideo
            ? 'While a video shows, the slide plays it to the end and then moves on; this time is used when a picture shows.'
            : 'Then the next slide shows. It never moves on for visitors who turned off motion.'}
        </p>
        <div className="hbn-two">
          <div className="hb-field">
            <label htmlFor={startId}>Start date (optional)</label>
            <input id={startId} className="hb-input" type="date" value={slide.startsAt} disabled={disabled} onChange={(e) => set({ startsAt: e.target.value })} />
          </div>
          <div className="hb-field">
            <label htmlFor={endId}>End date (optional)</label>
            <input id={endId} className={`hb-input${slide.startsAt && slide.endsAt && slide.endsAt < slide.startsAt ? ' hb-input--invalid' : ''}`}
              type="date" value={slide.endsAt} min={slide.startsAt || undefined} disabled={disabled} onChange={(e) => set({ endsAt: e.target.value })} />
          </div>
        </div>
        <p className="hb-field__hint">The slide shows from the start of its start date to the end of its end date.</p>
      </fieldset>

      {canWrite && (
        <div className="hbn-actions">
          <Button busy={busy === 'save'} disabled={!dirty || errors.length > 0 || Boolean(busy)} onClick={onSave}>
            {slide.isNew ? 'Save slide' : 'Save changes'}
          </Button>
          <Button variant="secondary" disabled={!dirty || Boolean(busy)} onClick={onUndo}>
            {slide.isNew ? 'Remove unsaved slide' : 'Undo changes'}
          </Button>
          {!slide.isNew && (
            <Button variant="soft" disabled={dirty || Boolean(busy)} title={dirty ? 'Save or undo your changes first' : undefined} onClick={onDuplicate}>
              Duplicate
            </Button>
          )}
          {!slide.isNew && <button type="button" className="hb-danger-link" disabled={Boolean(busy)} onClick={onDelete}>Delete slide</button>}
        </div>
      )}
    </section>
  );
}

export default HeroBanners;
