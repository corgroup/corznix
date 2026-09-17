import { useId, useMemo, useState } from 'react';
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
import { StatePill, PathSuggestions } from '../header/HeaderEditors.jsx';
import { buildEntityIndex, same } from '../header/headerModel.js';
import { SectionEditor } from './HomepageEditors.jsx';
import * as H from './homepageModel.js';
import '../header/HeaderBuilder.css';
import './HomepageBuilder.css';

// CMS -> Experience -> Homepage.
//
// Left: the homepage's sections top to bottom — drag to reorder, switch on or
// off, add or remove — and the selected section's editor (its copy, products,
// button, background). Right: the REAL storefront rendering the unsaved draft
// (LivePreview), scrolled to and outlining the section being edited; clicking
// a section in the preview selects it here.
//
// Save draft writes the draft; Publish homepage makes it live. Hero slides
// are managed below this builder (they have their own schedule).

export function HomepageBuilder({ canWrite, canPublish }) {
  const res = useApiResource(async () => {
    const [home, pub] = await Promise.all([adminApi.content.homepage(), adminApi.content.published('homepage')]);
    return { home, pub: pub.published?.snapshot || null };
  });
  const collections = useApiResource(() => adminApi.catalog.collections());
  const categories = useApiResource(() => adminApi.catalog.categories());
  const pages = useApiResource(() => adminApi.content.pages());
  // The store's synced Instagram posts, for the Instagram section's editor and preview.
  const instagram = useApiResource(() => adminApi.instagram.posts());

  // Outside the remounting inner tree: saving must not reset the selection
  // or the preview size.
  const [selectedKey, setSelectedKey] = useState(null);
  const [device, setDevice] = useState('desktop');
  const [resetKey, setResetKey] = useState(0);
  const [notice, setNotice] = useState(null);

  const pickers = useMemo(() => ({
    COLLECTION: {
      status: collections.status === 'ready' && categories.status === 'ready' ? 'ready' : 'loading',
      options: [
        // [slug, shown in the list, id, entity type, entity name]
        ...(collections.data?.collections ?? []).filter((c) => c.status === 'ACTIVE').map((c) => [c.slug, c.name, c.id, 'COLLECTION', c.name]),
        ...(categories.data?.categories ?? []).filter((c) => c.status === 'ACTIVE').map((c) => [c.slug, `${c.name} (category)`, c.id, 'CATEGORY', c.name]),
      ],
    },
    CONTENT_PAGE: { status: pages.status, options: (pages.data?.pages ?? []).map((p) => [p.slug, p.title, p.id, 'PAGE', p.title]) },
  }), [collections.status, collections.data, categories.status, categories.data, pages.status, pages.data]);

  const entities = useMemo(() => (collections.status === 'ready' && categories.status === 'ready'
    ? buildEntityIndex({
      collections: collections.data?.collections ?? [],
      categories: categories.data?.categories ?? [],
      pages: pages.data?.pages ?? [],
    })
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
          <div className="hb-col"><Skeleton lines={6} height={44} /></div>
          <div className="hb-col"><Skeleton height={560} /></div>
        </div>
      </div>
    );
  }
  if (res.status === 'error') return <ErrorState message={res.error?.message} onRetry={res.reload} />;

  return (
    <HomepageBuilderInner
      key={`${res.data.home.document.workingVersion}.${resetKey}`}
      data={res.data} reload={res.reload}
      pickers={pickers} entities={entities} activeSlugs={activeSlugs} archivedSlugs={archivedSlugs} instagram={instagram}
      canWrite={canWrite} canPublish={canPublish}
      selectedKey={selectedKey} onSelect={setSelectedKey}
      device={device} onDevice={setDevice}
      onDiscard={() => { setNotice(null); setResetKey((k) => k + 1); }}
      notice={notice} setNotice={setNotice}
    />
  );
}

function AddSection({ sections, onAdd }) {
  const id = useId();
  return (
    <div className="hp-add">
      <label htmlFor={id} className="hp-add__label">Add a section</label>
      <select id={id} className="hb-input" value="" onChange={(e) => { if (e.target.value) onAdd(e.target.value); }}>
        <option value="">Choose what to add…</option>
        {H.ADDABLE.map((type) => {
          const ok = H.canAdd(type, sections);
          return (
            <option key={type} value={type} disabled={!ok}>
              {H.TYPE_INFO[type].name}{ok ? ` — ${H.TYPE_INFO[type].blurb}` : ' (already on the page)'}
            </option>
          );
        })}
      </select>
    </div>
  );
}

function HomepageBuilderInner({
  data, reload, pickers, entities, activeSlugs, archivedSlugs, instagram, canWrite, canPublish,
  selectedKey, onSelect, device, onDevice, onDiscard, notice, setNotice,
}) {
  const [sections, setSections] = useState(() => data.home.sections.map(H.hydrateSection));
  const [base, setBase] = useState(() => ({
    byId: Object.fromEntries(data.home.sections.map((s) => [s.id, H.serializeSection(H.hydrateSection(s))])),
    order: data.home.sections.map((s) => s.id),
  }));
  const [deleted, setDeleted] = useState([]);
  const [version, setVersion] = useState(data.home.document.workingVersion);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [rendered, setRendered] = useState({});

  // ---- dirty tracking + checks --------------------------------------------
  const dirty = (s) => s.isNew || !same(H.serializeSection(s), base.byId[s.id]);
  const orderDirty = !same(
    sections.filter((s) => !s.isNew).map((s) => s.id),
    base.order.filter((id) => !deleted.includes(id)),
  );
  const dirtyCount = sections.filter(dirty).length + deleted.length + (orderDirty ? 1 : 0);
  const anyDirty = dirtyCount > 0;
  useUnsavedGuard(anyDirty);

  const instagramData = instagram.status === 'ready' ? instagram.data : null;
  const checks = Object.fromEntries(sections.map((s) => [s._k, H.validateSection(s, entities, instagramData)]));
  const problemCount = Object.values(checks).reduce((n, c) => n + c.errors.length, 0);

  const current = sections.find((s) => s.sectionKey === selectedKey) || sections[0] || null;
  const patch = (next) => setSections((cur) => cur.map((s) => (s._k === next._k ? next : s)));

  // Rebuilt every render; LivePreview only posts when its content changes.
  const previewMessage = {
    type: 'homepage',
    data: { sections: H.previewSections(sections, entities, instagramData) },
    ui: { sectionKey: current?.enabled ? current.sectionKey : null },
  };
  const onPreviewUi = (ui) => {
    if (ui.renderedSections) setRendered(ui.renderedSections);
    if (ui.sectionKey && sections.some((s) => s.sectionKey === ui.sectionKey)) onSelect(ui.sectionKey);
  };

  // ---- local changes -------------------------------------------------------
  const addSection = (type) => {
    const s = H.newSection(type, sections);
    // A new section lands right after the one being edited, where the editor is looking.
    setSections((cur) => {
      const at = current ? cur.findIndex((x) => x._k === current._k) + 1 : cur.length;
      return [...cur.slice(0, at), s, ...cur.slice(at)];
    });
    onSelect(s.sectionKey);
  };

  const removeSection = (s) => {
    if (!window.confirm(`Remove “${H.sectionTitle(s)}” from the homepage? It disappears from the website when you publish.`)) return;
    setSections((cur) => cur.filter((x) => x._k !== s._k));
    if (!s.isNew) setDeleted((d) => [...d, s.id]);
    onSelect(null);
  };

  // ---- save draft ----------------------------------------------------------
  const save = async () => {
    setActionError(null); setNotice(null); setSaving(true);
    let v = version;
    const working = [...sections];
    let serverOrder = base.order.filter((id) => !deleted.includes(id));
    try {
      for (const id of deleted) {
        const r = await adminApi.content.deleteHomeSection(id, v);
        v = r.document.workingVersion;
        serverOrder = r.sections.map((x) => x.id);
        setDeleted((d) => d.filter((x) => x !== id));
      }
      for (let i = 0; i < working.length; i += 1) {
        const s = working[i];
        if (!dirty(s)) continue;
        const body = H.serializeSection(s);
        const r = await adminApi.content.upsertHomeSection({ ...body, id: s.isNew ? undefined : s.id, expectedVersion: v });
        v = r.document.workingVersion;
        serverOrder = r.sections.map((x) => x.id);
        const server = r.sections.find((x) => x.sectionKey === s.sectionKey);
        // _k stays the same so the list and the selection do not jump.
        const saved = { ...s, id: server.id, isNew: false };
        working[i] = saved;
        setSections((cur) => cur.map((x) => (x._k === s._k ? saved : x)));
        setBase((b) => ({ ...b, byId: { ...b.byId, [saved.id]: H.serializeSection(saved) }, order: serverOrder }));
      }
      const wanted = working.map((x) => x.id);
      if (!same(wanted, serverOrder)) {
        const r = await adminApi.content.reorderHomeSections(wanted, v);
        v = r.document.workingVersion;
      }
      setBase((b) => ({ ...b, order: wanted }));
      setVersion(v);
      setNotice('Draft saved. Customers still see the published homepage until you publish.');
      reload();
    } catch (err) {
      // Everything saved before the failure is kept (and no longer marked
      // unsaved); the rest stays in the editor to fix and save again.
      setVersion(v);
      setActionError(err);
    } finally {
      setSaving(false);
    }
  };

  // ---- publish -------------------------------------------------------------
  const doc = data.home.document;
  const publish = async () => {
    setActionError(null); setNotice(null); setPublishing(true);
    try {
      await adminApi.content.publish('homepage', doc.workingVersion);
      setNotice('Published. The live homepage now matches this draft.');
      reload();
    } catch (err) {
      setActionError(err);
    } finally {
      setPublishing(false);
    }
  };

  // Whether the saved draft differs from the live homepage, decided by the
  // content itself — not the document's "edited since publish" flag, which
  // stays set when a change is made and then undone.
  const liveKeys = (data.pub?.sections || []).map((p) => p.key);
  const unpublished = !data.pub
    || sections.some((s) => !['live', 'off'].includes(H.sectionState(s, data.pub)))
    || liveKeys.some((key) => !sections.some((s) => s.enabled && s.sectionKey === key))
    || H.orderUnpublished(sections, data.pub);
  const status = anyDirty ? { tone: 'warn', label: `${dirtyCount} unsaved change${dirtyCount === 1 ? '' : 's'}` }
    : unpublished ? { tone: 'info', label: 'Saved draft — not published' }
      : { tone: 'good', label: 'Live — matches the website' };

  return (
    <div className="hb hp">
      <PathSuggestions pickers={pickers} />
      <div className="hb-top">
        <div className="hb-top__text">
          <h2 className="hb-top__title">Homepage</h2>
          <ol className="hb-steps" aria-label="How it works">
            <li><span>1</span>Pick a section — here or in the preview</li>
            <li><span>2</span>Edit — the preview updates as you type</li>
            <li className={anyDirty ? 'hb-steps__now' : ''}><span>3</span>Save draft</li>
            <li className={!anyDirty && unpublished ? 'hb-steps__now' : ''}><span>4</span>Publish homepage — customers see it</li>
          </ol>
        </div>
        <div className="hb-top__actions">
          <span className={`hb-status hb-status--${status.tone}`} role="status">{status.label}</span>
          {canWrite && <Button variant="secondary" disabled={!anyDirty || saving} onClick={() => { if (window.confirm('Discard all unsaved homepage changes?')) onDiscard(); }}>Discard</Button>}
          {canWrite && <Button busy={saving} disabled={!anyDirty || problemCount > 0} onClick={save}>Save draft</Button>}
          {canPublish && <Button variant="success" busy={publishing} disabled={anyDirty || !unpublished} onClick={publish} title={anyDirty ? 'Save your changes first' : undefined}>Publish homepage</Button>}
        </div>
      </div>

      {problemCount > 0 && <InlineAlert tone="warning">{problemCount} problem{problemCount === 1 ? '' : 's'} to fix before saving — sections with a red number need attention.</InlineAlert>}
      {actionError && <InlineAlert tone="error">{actionError.message}</InlineAlert>}
      {/* "Saved" / "Published" describe the page as it was; once there are new
          unsaved edits they are no longer true, so they go. */}
      {notice && !actionError && !anyDirty && <InlineAlert tone="success">{notice}</InlineAlert>}

      <div className="hb-layout">
        <div className="hb-col hb-col--edit">
          <section className="hb-panel" aria-labelledby="hp-sections-title">
            <div className="hb-panel__head">
              <h3 id="hp-sections-title" className="hb-panel__title">Sections, top to bottom</h3>
              <span className="hb-panel__hint">Drag to reorder</span>
            </div>
            <div className="hb-bar-logo" aria-hidden="true">Announcement bar &amp; header · always first</div>
            <SortableList
              label="Homepage sections"
              items={sections}
              getKey={(s) => s._k}
              disabled={!canWrite}
              onReorder={setSections}
              renderItem={(s, i, { handleProps }) => {
                const active = current?._k === s._k;
                const errs = checks[s._k].errors.length;
                const nothingToShow = s.enabled && rendered[s.sectionKey] === false;
                const title = H.sectionTitle(s);
                return (
                  <div className={`hb-item${active ? ' hb-item--active' : ''}${!s.enabled || H.UNSUPPORTED.has(s.type) ? ' hb-item--off' : ''}`}>
                    <DragHandle {...handleProps} disabled={!canWrite} />
                    <button type="button" className="hb-item__main" aria-current={active || undefined} onClick={() => onSelect(s.sectionKey)}>
                      <span className="hb-item__label">{title}</span>
                      <span className="hb-item__meta">
                        {H.sectionSub(s, entities)}
                        {nothingToShow ? ' · nothing to show yet' : ''}
                        {dirty(s) ? <span className="hb-dot" title="Unsaved changes" /> : null}
                      </span>
                    </button>
                    {errs > 0 && <span className="hb-item__errors" title={`${errs} problem(s)`}>{errs}</span>}
                    <StatePill state={H.sectionState(s, data.pub)} compact />
                    {canWrite && (
                      <button type="button" className="hb-icon-btn" aria-pressed={s.enabled}
                        aria-label={s.enabled ? `Hide ${title}` : `Show ${title}`}
                        onClick={() => patch({ ...s, enabled: !s.enabled })}>
                        {s.enabled ? <EyeIcon /> : <EyeOffIcon />}
                      </button>
                    )}
                  </div>
                );
              }}
            />
            {canWrite && <AddSection sections={sections} onAdd={addSection} />}
            <div className="hb-locked">
              <span>Footer</span>
              <span className="hb-locked__note">Always last — edit it in the Footer tab</span>
            </div>
            {orderDirty && <p className="hb-panel__note">Order changed — save to keep it.</p>}
            {!orderDirty && H.orderUnpublished(sections, data.pub) && <p className="hb-panel__note">Saved order is not published yet — customers still see the old order.</p>}
          </section>

          {current && (
            <SectionEditor
              key={current._k}
              section={current}
              onChange={patch}
              pickers={pickers}
              entities={entities}
              activeSlugs={activeSlugs}
              archivedSlugs={archivedSlugs}
              instagram={instagram}
              canWrite={canWrite}
              errors={checks[current._k].errors}
              warnings={checks[current._k].warnings}
              state={H.sectionState(current, data.pub)}
              rendered={rendered[current.sectionKey]}
              onRemove={() => removeSection(current)}
              onManageHero={() => document.getElementById('hero-banners')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            />
          )}
        </div>

        <div className="hb-col hb-col--preview">
          <div className="hb-preview-sticky">
            <LivePreview
              title="Homepage preview"
              message={previewMessage}
              device={device}
              onDeviceChange={onDevice}
              devices={['desktop', 'tablet', 'mobile']}
              height={680}
              onUi={onPreviewUi}
            />
            <div className="hb-preview-foot">
              <span>
                {current && current.enabled ? `Outlined: “${H.sectionTitle(current)}”` : current ? `“${H.sectionTitle(current)}” is hidden — switch it on to see it` : ''}
              </span>
              <span>Click a section in the preview to edit it</span>
            </div>
          </div>
        </div>
      </div>

      <details className="hb-history">
        <summary>Version history &amp; rollback</summary>
        <PublishBar scope="homepage" doc={doc} canPublish={canPublish} onDone={reload} />
      </details>
    </div>
  );
}

const EyeIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" /><circle cx="12" cy="12" r="3" /></svg>
);
const EyeOffIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 19C5 19 1 12 1 12a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M1 1l22 22" /></svg>
);

export default HomepageBuilder;
