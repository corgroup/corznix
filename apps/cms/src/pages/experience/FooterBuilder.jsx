import { useMemo, useState } from 'react';
import { Button } from '../../components/ui/Button.jsx';
import { FormField } from '../../components/ui/FormField.jsx';
import { InlineAlert } from '../../components/feedback/InlineAlert.jsx';
import { ErrorState } from '../../components/feedback/ErrorState.jsx';
import { Skeleton } from '../../components/feedback/Skeleton.jsx';
import { makeRowKey } from '../../components/ui/rowHelpers.js';
import { PublishBar } from '../../components/content/PublishBar.jsx';
import { adminApi } from '../../api/adminApi.js';
import { useApiResource } from '../../hooks/useApiResource.js';
import { useMutation } from '../../features/catalog/useMutation.js';
import './FooterBuilder.css';

// Visual footer builder for CMS -> Experience -> Footer.
//
// PHASE 0 AUDIT (kept as the map this file was built from):
//   - 4 fixed backend groups (shop/about/help/legal), NOT reorderable and
//     NOT addable/removable — content_footer_groups is seeded once from a
//     hardcoded key list; there is no reorder/create/delete endpoint. So the
//     left panel lists them but never offers drag-and-drop for the section
//     order (§ SECTION REORDERING — "if not editable, do not invent it").
//   - Links WITHIN a group ARE reorderable (position = array order on save).
//   - Contact + socials is a separate `meta` document slice, own endpoint —
//     kept as its own pseudo-section ("Contact & Socials"), not a 5th group.
//   - No Newsletter field exists anywhere in this data model (the storefront
//     footer's newsletter box is static UI, not CMS content) — not added
//     here; the preview renders it non-interactively for visual accuracy only.
//   - Draft/publish/history/rollback is the existing shared PublishBar,
//     reused verbatim (scope="footer" already used the correct 'header'
//     preview-token scope — footer content is delivered inside
//     GET /content/header, confirmed in navigationService.js).
//   - Server validation is unchanged: label required, EXTERNAL -> a real
//     http(s) URL, everything else -> validateInternalTarget (slug must
//     exist). This file adds real pickers sourced from the same catalog/
//     pages the CMS already lists elsewhere, but never blocks on the picker
//     load — a value outside the fetched options is preserved verbatim (a
//     stale/rare slug must never be silently dropped by this UI).
const GROUP_DEFS = [
  { key: 'shop', label: 'Shop', hint: 'Collections and product routes customers browse to.' },
  { key: 'about', label: 'About', hint: 'Brand story pages.' },
  { key: 'help', label: 'Help', hint: 'Support and policy pages.' },
  { key: 'legal', label: 'Legal', hint: 'Renders in the footer’s bottom bar, not a link column.' },
];

// Readable labels only — the value posted to the API is always the raw enum.
const LINK_TYPE_LABELS = {
  COLLECTION: 'Collection', CATEGORY: 'Category', PRODUCT: 'Product',
  CONTENT_PAGE: 'Content page', CUSTOM_INTERNAL: 'Internal link',
  HOME: 'Homepage', SEARCH: 'Search page', EXTERNAL: 'External URL',
};
const FOOTER_LINK_TYPES = ['CONTENT_PAGE', 'COLLECTION', 'CATEGORY', 'PRODUCT', 'CUSTOM_INTERNAL', 'HOME', 'SEARCH', 'EXTERNAL'];
const NO_TARGET_TYPES = new Set(['HOME', 'SEARCH']);
const PICKER_TYPES = new Set(['COLLECTION', 'CATEGORY', 'CONTENT_PAGE', 'PRODUCT']);
const SOCIAL_ICON_CHOICES = ['instagram', 'facebook', 'pinterest', 'youtube', 'twitter', 'linkedin', 'tiktok', 'whatsapp'];

// Mirrors homepageService.js#linkRoute EXACTLY — this is what the storefront
// will actually resolve, used only to render the preview's tooltip/tab title.
function resolvePath(linkType, target, externalUrl) {
  switch (linkType) {
    case 'HOME': return '/';
    case 'SEARCH': return '/search';
    case 'COLLECTION': case 'CATEGORY': return `/collections/${target || ''}`;
    case 'PRODUCT': return `/products/${target || ''}`;
    case 'CONTENT_PAGE': return `/pages/${target || ''}`;
    case 'EXTERNAL': return externalUrl || '';
    default: return target || '/';
  }
}

// A link picked from a list is a REFERENCE (linkRefType + linkRefId): the
// website shows the entity's current name and URL, so the label typed here is
// only what the CMS lists show.
const hydrateLinks = (group) => (group?.links ?? []).map((l) => ({
  _k: makeRowKey(), label: l.label || '', linkType: l.linkType || 'CUSTOM_INTERNAL',
  linkTarget: l.linkTarget || '', externalUrl: l.externalUrl || '',
  linkRefType: l.linkRefType || null, linkRefId: l.linkRefId || null,
}));
const serializeLinks = (rows) => rows.map((r) => ({
  label: (r.label || '').trim(),
  linkType: r.linkType || 'CUSTOM_INTERNAL',
  linkTarget: r.linkType === 'EXTERNAL' ? null : ((r.linkTarget || '').trim() || null),
  externalUrl: r.linkType === 'EXTERNAL' ? ((r.externalUrl || '').trim() || null) : null,
  linkRefType: r.linkRefId ? r.linkRefType : null,
  linkRefId: r.linkRefId || null,
}));
const linksEqual = (a, b) => JSON.stringify(serializeLinks(a)) === JSON.stringify(serializeLinks(b));

// The website shows a referenced page / category / collection by its CURRENT
// name (server entityLinks.js), so the builder shows the same — never the
// label typed when the link was first made. Null for custom links.
function liveName(row, pickers) {
  if (!row.linkRefId) return null;
  for (const key of ['COLLECTION', 'CATEGORY', 'CONTENT_PAGE']) {
    const opt = pickers?.[key]?.options?.find((o) => o[2] === row.linkRefId);
    if (opt) return opt[4];
  }
  return null;
}

const hydrateMeta = (meta) => ({
  contact: {
    email: meta?.contact?.email || '', phone: meta?.contact?.phone || '',
    phoneHref: meta?.contact?.phoneHref || '', location: meta?.contact?.location || '',
  },
  socials: (meta?.socials || []).map((s) => ({ _k: makeRowKey(), label: s.label || '', href: s.href || '', icon: s.icon || '' })),
});
const serializeMeta = (state) => ({
  contact: Object.fromEntries(Object.entries(state.contact).filter(([, v]) => (v || '').trim() !== '').map(([k, v]) => [k, v.trim()])),
  socials: state.socials.map((s) => ({ label: (s.label || '').trim(), href: (s.href || '').trim(), icon: (s.icon || '').trim() })).filter((s) => s.href),
});
const metaEqual = (a, b) => JSON.stringify(serializeMeta(a)) === JSON.stringify(serializeMeta(b));

// ---- entry point -------------------------------------------------------

export function FooterBuilder({ canWrite, canPublish }) {
  const { status, data, error, reload } = useApiResource(() => adminApi.content.footer());
  // Owned here, not in FooterBuilderInner — that tree remounts on every save
  // (see the `key` below), and a staff member saving Shop should stay on
  // Shop afterwards, not get bounced back to the first section.
  const [selected, setSelected] = useState('shop');
  // Real pickers, sourced from the same lists the rest of the CMS already
  // shows — never invented data. A slow/failed fetch never blocks editing;
  // DestinationField falls back to a plain text input.
  const collectionsRes = useApiResource(() => adminApi.catalog.collections());
  const categoriesRes = useApiResource(() => adminApi.catalog.categories());
  const pagesRes = useApiResource(() => adminApi.content.pages());
  const productsRes = useApiResource(() => adminApi.catalog.listProducts({ limit: 100, sort: 'name' }));

  const pickers = useMemo(() => ({
    // /collections/<slug> resolves categories too (server validateInternalTarget
    // accepts both), so a Shop link to the tops category is not 'not found'.
    COLLECTION: {
      status: collectionsRes.status === 'ready' && categoriesRes.status === 'ready' ? 'ready' : (collectionsRes.status === 'error' || categoriesRes.status === 'error' ? 'error' : 'loading'),
      options: [
        ...(collectionsRes.data?.collections ?? []).filter((c) => c.status === 'ACTIVE').map((c) => [c.slug, c.name, c.id, 'COLLECTION', c.name]),
        ...(categoriesRes.data?.categories ?? []).filter((c) => c.status === 'ACTIVE').map((c) => [c.slug, `${c.name} (category)`, c.id, 'CATEGORY', c.name]),
      ],
    },
    CATEGORY: { status: categoriesRes.status, options: (categoriesRes.data?.categories ?? []).filter((c) => c.status === 'ACTIVE').map((c) => [c.slug, c.name, c.id, 'CATEGORY', c.name]) },
    CONTENT_PAGE: { status: pagesRes.status, options: (pagesRes.data?.pages ?? []).filter((p) => p.status === 'ACTIVE').map((p) => [p.slug, p.title, p.id, 'PAGE', p.title]) },
    PRODUCT: { status: productsRes.status, options: (productsRes.data?.products ?? []).map((p) => [p.slug, p.name]) },
  }), [collectionsRes.status, collectionsRes.data, categoriesRes.status, categoriesRes.data, pagesRes.status, pagesRes.data, productsRes.status, productsRes.data]);

  if (status === 'loading') return <FooterBuilderSkeleton />;
  if (status === 'error') return <ErrorState message={error?.message} onRetry={reload} />;

  const { document: doc, groups, meta } = data;
  return (
    <FooterBuilderInner
      key={doc.workingVersion}
      doc={doc} groups={groups} meta={meta} pickers={pickers}
      canWrite={canWrite} canPublish={canPublish} reload={reload}
      selected={selected} onSelect={setSelected}
    />
  );
}

function FooterBuilderSkeleton() {
  return (
    <div className="footer-builder">
      <div className="footer-builder__hero"><Skeleton height={20} width={160} /><Skeleton height={14} width={360} style={{ marginTop: 8 }} /></div>
      <div className="footer-builder__layout">
        <div className="footer-builder__col footer-builder__col--nav"><Skeleton lines={5} height={52} /></div>
        <div className="footer-builder__col footer-builder__col--editor"><Skeleton lines={4} height={40} /></div>
        <div className="footer-builder__col footer-builder__col--preview"><Skeleton height={320} /></div>
      </div>
    </div>
  );
}

// ---- builder shell -------------------------------------------------------

function FooterBuilderInner({ doc, groups, meta, pickers, canWrite, canPublish, reload, selected, onSelect }) {
  const byKey = useMemo(() => new Map(groups.map((g) => [g.groupKey, g])), [groups]);
  // Captured once per mount (this whole tree remounts — same key={workingVersion}
  // trick every other Experience tab already uses — whenever ANY section saves,
  // since all footer sections share one document version). Dirty-diffing and
  // Discard both compare against this frozen baseline.
  const original = useMemo(() => ({
    rows: Object.fromEntries(GROUP_DEFS.map((g) => [g.key, hydrateLinks(byKey.get(g.key))])),
    meta: hydrateMeta(meta),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  const [rows, setRows] = useState(original.rows);
  const [metaState, setMetaState] = useState(original.meta);

  const dirty = useMemo(() => ({
    shop: !linksEqual(rows.shop, original.rows.shop),
    about: !linksEqual(rows.about, original.rows.about),
    help: !linksEqual(rows.help, original.rows.help),
    legal: !linksEqual(rows.legal, original.rows.legal),
    contact: !metaEqual(metaState, original.meta),
  }), [rows, metaState, original]);
  const anyDirty = Object.values(dirty).some(Boolean);
  // What the footer actually shows: referenced links carry their entity's live name.
  const shownRows = useMemo(
    () => Object.fromEntries(Object.entries(rows).map(([k, list]) => [k, list.map((r) => ({ ...r, label: liveName(r, pickers) ?? r.label }))])),
    [rows, pickers],
  );

  const storefrontUrl = import.meta.env.VITE_STOREFRONT_URL || 'http://localhost:5173';

  return (
    <div className="footer-builder">
      <div className="footer-builder__hero">
        <div>
          <h2 className="footer-builder__title">Footer</h2>
          <p className="footer-builder__desc">
            Manage footer link columns, contact details and social links. Changes are saved as draft and go live only when you publish.
          </p>
        </div>
        <a className="linkish" href={storefrontUrl} target="_blank" rel="noopener noreferrer">View store ↗</a>
      </div>

      <div className="footer-builder__layout">
        <SectionNav selected={selected} onSelect={onSelect} rows={rows} metaState={metaState} dirty={dirty} />

        <div className="footer-builder__col footer-builder__col--editor">
          {selected === 'contact' ? (
            <ContactSocialsEditor
              state={metaState} onChange={setMetaState} original={original.meta} dirty={dirty.contact}
              canWrite={canWrite} version={doc.workingVersion} onSaved={reload}
            />
          ) : (
            <LinkSectionEditor
              key={selected}
              def={GROUP_DEFS.find((g) => g.key === selected)}
              rowsForGroup={rows[selected]}
              onChange={(next) => setRows((s) => ({ ...s, [selected]: next }))}
              original={original.rows[selected]}
              dirty={dirty[selected]}
              pickers={pickers}
              canWrite={canWrite} version={doc.workingVersion} onSaved={reload}
            />
          )}
        </div>

        <FooterPreview rows={shownRows} metaState={metaState} />
      </div>

      {anyDirty && (
        <InlineAlert tone="warning">
          You have unsaved changes in {Object.entries(dirty).filter(([, d]) => d).map(([k]) => (GROUP_DEFS.find((g) => g.key === k)?.label || 'Contact & Socials')).join(', ')}. Save each section separately — Publish only ships already-saved sections.
        </InlineAlert>
      )}
      <PublishBar scope="footer" doc={doc} canPublish={canPublish} onDone={reload} />
    </div>
  );
}

// ---- left panel: section list --------------------------------------------

function SectionNav({ selected, onSelect, rows, metaState, dirty }) {
  const socialCount = metaState.socials.filter((s) => (s.href || '').trim()).length;
  const contactCount = Object.values(metaState.contact).filter((v) => (v || '').trim()).length;
  return (
    <nav className="footer-builder__col footer-builder__col--nav" aria-label="Footer sections">
      {GROUP_DEFS.map((g) => (
        <SectionCard
          key={g.key} active={selected === g.key} dirty={dirty[g.key]}
          onClick={() => onSelect(g.key)} icon={<SectionIcon name={g.key} />}
          title={g.label} subtitle={`${rows[g.key].length} link${rows[g.key].length === 1 ? '' : 's'}`}
        />
      ))}
      <SectionCard
        active={selected === 'contact'} dirty={dirty.contact}
        onClick={() => onSelect('contact')} icon={<SectionIcon name="contact" />}
        title="Contact & Socials" subtitle={`${contactCount} contact field${contactCount === 1 ? '' : 's'} · ${socialCount} social account${socialCount === 1 ? '' : 's'}`}
      />
    </nav>
  );
}

function SectionCard({ active, dirty, onClick, icon, title, subtitle }) {
  return (
    <button type="button" className={`footer-section-card${active ? ' footer-section-card--active' : ''}`} onClick={onClick} aria-current={active || undefined}>
      <span className="footer-section-card__icon" aria-hidden="true">{icon}</span>
      <span className="footer-section-card__body">
        <span className="footer-section-card__title">{title}</span>
        <span className="footer-section-card__subtitle">{subtitle}</span>
      </span>
      {dirty && <span className="footer-section-card__dot" title="Unsaved changes" aria-label="Unsaved changes" />}
      <span className="footer-section-card__chevron" aria-hidden="true">›</span>
    </button>
  );
}

function SectionIcon({ name }) {
  const paths = {
    shop: 'M3 4h2l2.4 12.3a2 2 0 002 1.7h7.7a2 2 0 002-1.6L21 8H6',
    about: 'M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8zM14 3v5h5M9 13h6M9 17h6',
    help: 'M12 17h.01M9.5 9a2.5 2.5 0 115 0c0 1.5-2.5 2-2.5 4M12 2a10 10 0 100 20 10 10 0 000-20z',
    legal: 'M12 3l8 3v6c0 5-3.4 8.4-8 9-4.6-.6-8-4-8-9V6z',
    contact: 'M22 12a10 10 0 11-4-8M22 4L12 14l-3-3',
  };
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d={paths[name] || paths.shop} />
    </svg>
  );
}

// ---- center panel: a group's link editor ---------------------------------

function LinkSectionEditor({ def, rowsForGroup, onChange, original, dirty, pickers, canWrite, version, onSaved }) {
  const [save, { busy, error }] = useMutation((links) => adminApi.content.setFooterGroupLinks(def.key, links, version));
  const missingLabel = rowsForGroup.some((r) => !(r.label || '').trim());

  const patch = (i, part) => onChange(rowsForGroup.map((r, j) => (j === i ? { ...r, ...part } : r)));
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= rowsForGroup.length) return;
    const next = [...rowsForGroup];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const remove = (i) => onChange(rowsForGroup.filter((_, j) => j !== i));
  const add = () => onChange([...rowsForGroup, { _k: makeRowKey(), label: '', linkType: 'CONTENT_PAGE', linkTarget: '', externalUrl: '' }]);

  return (
    <div className="footer-editor">
      <div className="footer-editor__head">
        <div>
          <h3 className="footer-editor__title">{def.label}</h3>
          <p className="footer-editor__hint">{def.hint}</p>
        </div>
        <StatusPill dirty={dirty} />
      </div>

      <div className="footer-links">
        {rowsForGroup.map((r, i) => (
          <div className="footer-link-row" key={r._k}>
            <div className="footer-link-row__reorder">
              <button type="button" className="linkish" disabled={i === 0 || !canWrite} onClick={() => move(i, -1)} aria-label={`Move "${r.label || 'link'}" up`}>↑</button>
              <button type="button" className="linkish" disabled={i === rowsForGroup.length - 1 || !canWrite} onClick={() => move(i, 1)} aria-label={`Move "${r.label || 'link'}" down`}>↓</button>
            </div>
            <div className="footer-link-row__fields">
              <input
                className="footer-link-row__label"
                value={liveName(r, pickers) ?? r.label} disabled={!canWrite || Boolean(r.linkRefId)} placeholder="Link label"
                aria-label={`Label, row ${i + 1}`}
                title={r.linkRefId ? 'Uses the name of the linked page, category or collection — rename it there and it changes everywhere.' : undefined}
                onChange={(e) => patch(i, { label: e.target.value })}
              />
              <select
                className="footer-link-row__type"
                value={r.linkType} disabled={!canWrite}
                aria-label={`Link type, row ${i + 1}`}
                onChange={(e) => patch(i, { linkType: e.target.value, linkRefType: null, linkRefId: null })}
              >
                {FOOTER_LINK_TYPES.map((t) => <option key={t} value={t}>{LINK_TYPE_LABELS[t]}</option>)}
              </select>
              <DestinationField row={r} onPatch={(part) => patch(i, part)} pickers={pickers} disabled={!canWrite} rowIndex={i} />
            </div>
            <button type="button" className="footer-link-row__remove" disabled={!canWrite} onClick={() => remove(i)} aria-label={`Remove "${r.label || 'link'}"`}>✕</button>
          </div>
        ))}
        {rowsForGroup.length === 0 && <p className="footer-links__empty">No links in this column yet.</p>}
      </div>

      {canWrite && (
        <div className="footer-editor__toolbar">
          <button type="button" className="btn btn--secondary" onClick={add} disabled={rowsForGroup.length >= 30}>+ Add link</button>
          <span className="footer-editor__count">{rowsForGroup.length} / 30</span>
        </div>
      )}

      {missingLabel && <InlineAlert tone="warning">Every link needs a label.</InlineAlert>}
      {error && <InlineAlert tone="error">{error.message}</InlineAlert>}

      {canWrite && (
        <div className="editor-actions footer-editor__actions">
          <Button busy={busy} disabled={!dirty || missingLabel} onClick={async () => { await save(serializeLinks(rowsForGroup)); onSaved(); }}>
            Save {def.label} draft
          </Button>
          <Button variant="secondary" disabled={!dirty} onClick={() => onChange(original)}>Discard changes</Button>
        </div>
      )}
    </div>
  );
}

function DestinationField({ row, onPatch, pickers, disabled, rowIndex }) {
  if (row.linkType === 'EXTERNAL') {
    return (
      <input className="footer-link-row__dest" value={row.externalUrl} disabled={disabled} placeholder="https://…"
        aria-label={`External URL, row ${rowIndex + 1}`} onChange={(e) => onPatch({ externalUrl: e.target.value })} />
    );
  }
  if (NO_TARGET_TYPES.has(row.linkType)) {
    return <span className="footer-link-row__dest footer-link-row__dest--none">No destination needed</span>;
  }
  if (row.linkType === 'CUSTOM_INTERNAL') {
    return (
      <input className="footer-link-row__dest" value={row.linkTarget} disabled={disabled} placeholder="/path"
        aria-label={`Internal path, row ${rowIndex + 1}`} onChange={(e) => onPatch({ linkTarget: e.target.value })} />
    );
  }
  if (PICKER_TYPES.has(row.linkType)) {
    const picker = pickers[row.linkType];
    // Never invent — if the fetch failed or is still loading, fall back to a
    // plain slug input rather than blocking the editor.
    if (!picker || picker.status !== 'ready') {
      return (
        <input className="footer-link-row__dest" value={row.linkTarget} disabled={disabled} placeholder="slug"
          aria-label={`Target slug, row ${rowIndex + 1}`} onChange={(e) => onPatch({ linkTarget: e.target.value })} />
      );
    }
    const known = picker.options.some(([slug]) => slug === row.linkTarget);
    return (
      <select className="footer-link-row__dest" value={row.linkTarget} disabled={disabled}
        aria-label={`${LINK_TYPE_LABELS[row.linkType]} destination, row ${rowIndex + 1}`}
        onChange={(e) => {
          const opt = picker.options.find(([slug]) => slug === e.target.value);
          // Picking from the list links to the entity itself (and uses its name).
          onPatch(opt && opt[2]
            ? { linkTarget: opt[0], linkRefType: opt[3], linkRefId: opt[2], label: opt[4] }
            : { linkTarget: e.target.value, linkRefType: null, linkRefId: null });
        }}>
        <option value="">— choose —</option>
        {/* A stored slug that no longer matches a fetched option is preserved,
            never silently dropped, and flagged so staff notices it. */}
        {row.linkTarget && !known && <option value={row.linkTarget}>{row.linkTarget} (not found — check this)</option>}
        {picker.options.map(([slug, name]) => <option key={slug} value={slug}>{name}</option>)}
      </select>
    );
  }
  return (
    <input className="footer-link-row__dest" value={row.linkTarget} disabled={disabled} placeholder="slug"
      aria-label={`Target, row ${rowIndex + 1}`} onChange={(e) => onPatch({ linkTarget: e.target.value })} />
  );
}

function StatusPill({ dirty }) {
  return <span className={`footer-status-pill footer-status-pill--${dirty ? 'warn' : 'good'}`}>{dirty ? 'Unsaved changes' : 'Saved'}</span>;
}

// ---- center panel: contact & socials --------------------------------------

const DIGITS = (s) => (s || '').replace(/[^\d+]/g, '');

function ContactSocialsEditor({ state, onChange, original, dirty, canWrite, version, onSaved }) {
  const [save, { busy, error }] = useMutation((body) => adminApi.content.setFooterMeta(body, version));
  const setContact = (k) => (v) => onChange({ ...state, contact: { ...state.contact, [k]: v } });
  const setSocials = (socials) => onChange({ ...state, socials });

  const patchSocial = (i, part) => setSocials(state.socials.map((s, j) => (j === i ? { ...s, ...part } : s)));
  const removeSocial = (i) => setSocials(state.socials.filter((_, j) => j !== i));
  const addSocial = () => setSocials([...state.socials, { _k: makeRowKey(), label: '', href: '', icon: '' }]);
  const moveSocial = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= state.socials.length) return;
    const next = [...state.socials];
    [next[i], next[j]] = [next[j], next[i]];
    setSocials(next);
  };

  const emptyHrefRows = state.socials.filter((s) => (s.label || s.icon) && !(s.href || '').trim()).length;

  return (
    <div className="footer-editor">
      <div className="footer-editor__head">
        <div>
          <h3 className="footer-editor__title">Contact &amp; Socials</h3>
          <p className="footer-editor__hint">Shown in the footer&rsquo;s Connect column.</p>
        </div>
        <StatusPill dirty={dirty} />
      </div>

      <div className="footer-contact-grid">
        <FormField id="fc-email" label="Email" value={state.contact.email} onChange={setContact('email')} disabled={!canWrite} placeholder="hello@corcotton.in" />
        <FormField id="fc-phone" label="Phone" value={state.contact.phone} onChange={setContact('phone')} disabled={!canWrite} placeholder="+91 90000 00000" />
        <FormField id="fc-loc" label="Location" value={state.contact.location} onChange={setContact('location')} disabled={!canWrite} placeholder="City, Country" />
        <div className="form-field">
          <label htmlFor="fc-phhref">Phone action link</label>
          <div className="footer-phone-link-row">
            <input id="fc-phhref" value={state.contact.phoneHref} disabled={!canWrite} placeholder="tel:+919000000000"
              onChange={(e) => setContact('phoneHref')(e.target.value)} />
            <button type="button" className="linkish" disabled={!canWrite || !state.contact.phone.trim()}
              onClick={() => setContact('phoneHref')(`tel:${DIGITS(state.contact.phone)}`)}>
              Fill from phone
            </button>
          </div>
          <p className="tab-body__hint">Used when a customer taps the phone number.</p>
        </div>
      </div>

      <label className="footer-editor__subhead">Social accounts</label>
      <div className="footer-links">
        {state.socials.map((s, i) => (
          <div className="footer-link-row" key={s._k}>
            <div className="footer-link-row__reorder">
              <button type="button" className="linkish" disabled={i === 0 || !canWrite} onClick={() => moveSocial(i, -1)} aria-label={`Move "${s.label || 'social'}" up`}>↑</button>
              <button type="button" className="linkish" disabled={i === state.socials.length - 1 || !canWrite} onClick={() => moveSocial(i, 1)} aria-label={`Move "${s.label || 'social'}" down`}>↓</button>
            </div>
            <span className="footer-social-glyph" aria-hidden="true"><SocialGlyph icon={s.icon} /></span>
            <div className="footer-link-row__fields footer-link-row__fields--social">
              <input className="footer-link-row__label" value={s.label} disabled={!canWrite} placeholder="Instagram"
                aria-label={`Social platform, row ${i + 1}`} onChange={(e) => patchSocial(i, { label: e.target.value })} />
              <input className="footer-link-row__dest" value={s.href} disabled={!canWrite} placeholder="https://…"
                aria-label={`Social URL, row ${i + 1}`} onChange={(e) => patchSocial(i, { href: e.target.value })} />
              <input className="footer-link-row__type" value={s.icon} disabled={!canWrite} placeholder="icon" list="footer-social-icons"
                aria-label={`Social icon name, row ${i + 1}`} onChange={(e) => patchSocial(i, { icon: e.target.value })} />
            </div>
            <button type="button" className="footer-link-row__remove" disabled={!canWrite} onClick={() => removeSocial(i)} aria-label={`Remove "${s.label || 'social account'}"`}>✕</button>
          </div>
        ))}
        {state.socials.length === 0 && <p className="footer-links__empty">No social accounts yet.</p>}
      </div>
      <datalist id="footer-social-icons">{SOCIAL_ICON_CHOICES.map((i) => <option key={i} value={i} />)}</datalist>

      {canWrite && (
        <div className="footer-editor__toolbar">
          <button type="button" className="btn btn--secondary" onClick={addSocial} disabled={state.socials.length >= 10}>+ Add social account</button>
          <span className="footer-editor__count">{state.socials.length} / 10</span>
        </div>
      )}
      {emptyHrefRows > 0 && <InlineAlert tone="warning">{emptyHrefRows} social account{emptyHrefRows === 1 ? '' : 's'} without a URL won&rsquo;t be saved.</InlineAlert>}
      {error && <InlineAlert tone="error">{error.message}</InlineAlert>}

      {canWrite && (
        <div className="editor-actions footer-editor__actions">
          <Button busy={busy} disabled={!dirty} onClick={async () => { await save(serializeMeta(state)); onSaved(); }}>Save Contact &amp; Socials draft</Button>
          <Button variant="secondary" disabled={!dirty} onClick={() => onChange(original)}>Discard changes</Button>
        </div>
      )}
    </div>
  );
}

function SocialGlyph({ icon }) {
  const KNOWN = {
    instagram: 'M7 2h10a5 5 0 015 5v10a5 5 0 01-5 5H7a5 5 0 01-5-5V7a5 5 0 015-5zm5 5.5a4.5 4.5 0 100 9 4.5 4.5 0 000-9zM17.5 6a1 1 0 100 2 1 1 0 000-2z',
    facebook: 'M14 9h3V6h-3a4 4 0 00-4 4v2H7v3h3v6h3v-6h3l1-3h-4v-2a1 1 0 011-1z',
    pinterest: 'M12 2a10 10 0 00-3.6 19.3c0-.8 0-1.8.2-2.6l1.4-6s-.4-.7-.4-1.8c0-1.7 1-3 2.2-3 1 0 1.5.8 1.5 1.7 0 1-.7 2.6-1 4-.3 1.2.6 2.2 1.8 2.2 2.1 0 3.7-2.3 3.7-5.5 0-2.9-2-4.9-5-4.9-3.4 0-5.4 2.6-5.4 5.2 0 1 .4 2.1 .9 2.7a.4.4 0 01.1.4l-.3 1.3c0 .2-.2.3-.4.2-1.4-.6-2.3-2.6-2.3-4.3 0-3.5 2.5-6.7 7.3-6.7 3.8 0 6.8 2.7 6.8 6.4 0 3.8-2.4 6.9-5.8 6.9-1.1 0-2.2-.6-2.6-1.3l-.7 2.7c-.3 1-1 2.3-1.4 3.1A10 10 0 1012 2z',
    youtube: 'M21.6 7.2a2.5 2.5 0 00-1.8-1.8C18.1 5 12 5 12 5s-6.1 0-7.8.4A2.5 2.5 0 002.4 7.2 26 26 0 002 12a26 26 0 00.4 4.8 2.5 2.5 0 001.8 1.8C6 19 12 19 12 19s6.1 0 7.8-.4a2.5 2.5 0 001.8-1.8A26 26 0 0022 12a26 26 0 00-.4-4.8zM10 15V9l5.2 3z',
  };
  const key = (icon || '').trim().toLowerCase();
  const d = KNOWN[key];
  if (d) {
    return <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d={d} /></svg>;
  }
  // Honest fallback — matches the storefront's own AppsIcon fallback for an
  // icon name it doesn't recognise (iconRegistry.js), so this preview never
  // overpromises an icon that won't actually render distinctly.
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7">
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12h8M12 8v8" strokeLinecap="round" />
    </svg>
  );
}

// ---- right panel: live preview --------------------------------------------

const DEVICE_WIDTHS = { desktop: '100%', tablet: '460px', mobile: '300px' };

function FooterPreview({ rows, metaState }) {
  const [device, setDevice] = useState('desktop');
  const socials = metaState.socials.filter((s) => (s.href || '').trim());
  const year = new Date().getFullYear();

  return (
    <div className="footer-builder__col footer-builder__col--preview">
      <div className="footer-preview__head">
        <h3 className="footer-editor__title">Live preview</h3>
        <div className="footer-preview__devices" role="group" aria-label="Preview width">
          {Object.keys(DEVICE_WIDTHS).map((d) => (
            <button key={d} type="button" className={`footer-preview__device${device === d ? ' footer-preview__device--active' : ''}`}
              aria-pressed={device === d} onClick={() => setDevice(d)}>
              {d[0].toUpperCase() + d.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <p className="footer-editor__hint">Reflects your current draft, including unsaved edits — not just what&rsquo;s saved.</p>

      <div className="footer-preview__frame">
        <div className="footer-preview__viewport" style={{ width: DEVICE_WIDTHS[device] }}>
          <div className="footer-mock">
            <div className="footer-mock__grid">
              <div className="footer-mock__brand">
                <span className="footer-mock__logo">CORCOTTON</span>
                <p className="footer-mock__tagline">Subtle. Natural. Timeless.</p>
              </div>
              {GROUP_DEFS.filter((g) => g.key !== 'legal').map((g) => (
                <div className="footer-mock__col" key={g.key}>
                  <p className="footer-mock__head">{g.label}</p>
                  <ul>
                    {rows[g.key].map((r) => (
                      <li key={r._k} title={resolvePath(r.linkType, r.linkTarget, r.externalUrl)}>
                        {r.label || <em>(no label)</em>}
                      </li>
                    ))}
                    {rows[g.key].length === 0 && <li className="footer-mock__empty">—</li>}
                  </ul>
                </div>
              ))}
              <div className="footer-mock__col footer-mock__connect">
                <p className="footer-mock__head">Connect</p>
                <ul className="footer-mock__contact">
                  {metaState.contact.email && <li>✉ {metaState.contact.email}</li>}
                  {metaState.contact.phone && <li>☎ {metaState.contact.phone}</li>}
                  {metaState.contact.location && <li>⚲ {metaState.contact.location}</li>}
                  {!metaState.contact.email && !metaState.contact.phone && !metaState.contact.location && <li className="footer-mock__empty">No contact details yet</li>}
                </ul>
                {socials.length > 0 && (
                  <div className="footer-mock__socials">
                    {socials.map((s) => (
                      <span key={s._k} className="footer-mock__social-btn" title={s.href}><SocialGlyph icon={s.icon} /></span>
                    ))}
                  </div>
                )}
                {/* Newsletter box is real storefront UI but not CMS content —
                    shown here only so the preview matches reality; it is
                    never part of the footer draft/save contract. */}
                <div className="footer-mock__newsletter">
                  <p className="footer-mock__head">Stay in the Loop</p>
                  <div className="footer-mock__newsletter-input">Enter your email →</div>
                </div>
              </div>
            </div>
            <div className="footer-mock__bottom">
              <span>© {year} CORCOTTON™. All rights reserved.</span>
              <span className="footer-mock__legal-links">
                {rows.legal.map((r) => <span key={r._k} title={resolvePath(r.linkType, r.linkTarget, r.externalUrl)}>{r.label || '(no label)'}</span>)}
                {rows.legal.length === 0 && <em>No legal links yet</em>}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default FooterBuilder;
