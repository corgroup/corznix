import { useMemo, useState } from 'react';
import { adminApi } from '../../../api/adminApi.js';
import { useApiResource } from '../../../hooks/useApiResource.js';
import { Button } from '../../../components/ui/Button.jsx';
import { InlineAlert } from '../../../components/feedback/InlineAlert.jsx';
import { ErrorState } from '../../../components/feedback/ErrorState.jsx';
import { Skeleton } from '../../../components/feedback/Skeleton.jsx';
import { SortableList, DragHandle } from '../../../components/ui/SortableList.jsx';
import { useUnsavedGuard } from '../../../components/ui/rowHelpers.js';
import { LivePreview } from '../../../components/content/LivePreview.jsx';
import { PREVIEW_DEVICES } from '../../../components/content/previewDevices.js';
import { PublishBar } from '../../../components/content/PublishBar.jsx';
import { ItemEditor, MobileMenuEditor, StatePill } from './HeaderEditors.jsx';
import * as M from './headerModel.js';
import './HeaderBuilder.css';

// CMS -> Experience -> Header & Navigation.
//
// One screen for everything a customer sees in the header: the desktop bar
// (TOPS -> BOTTOMS -> ...), each dropdown (promo panel, category links, cards,
// fits), the mobile drawer (submenus, promo cards, secondary links, tagline).
//
// Left: the structure, drag to reorder, switch items on/off.
// Middle: the selected item's editor.
// Right: the REAL storefront rendering the unsaved draft (LivePreview), with
// the dropdown or mobile submenu being edited held open.
//
// Save draft writes to the same draft tables the storefront preview tokens
// read; Publish header makes it live (dropdowns first, then the bar, since the
// bar references them). Nothing here is a second copy of the storefront.

const MOBILE_UI_MAX_WIDTH = 1023; // below this the storefront shows the hamburger drawer

export function HeaderBuilder({ canWrite, canPublish }) {
  const res = useApiResource(async () => {
    const [nav, mega, ann, pubNav, pubMega] = await Promise.all([
      adminApi.content.navigation(),
      adminApi.content.megaMenus(),
      adminApi.content.announcements(),
      adminApi.content.published('navigation'),
      adminApi.content.published('mega-menus'),
    ]);
    return { nav, mega, ann, pubNav: pubNav.published?.snapshot || null, pubMega: pubMega.published?.snapshot || null };
  });
  const collections = useApiResource(() => adminApi.catalog.collections());
  const categories = useApiResource(() => adminApi.catalog.categories());
  const pages = useApiResource(() => adminApi.content.pages());
  const products = useApiResource(() => adminApi.catalog.listProducts({ limit: 100, sort: 'name' }));

  // Kept outside the remounting inner tree: saving must not bounce the editor
  // back to the first item or reset the preview size.
  const [selection, setSelection] = useState(null);   // { kind: 'item', key } | { kind: 'mobile' }
  const [device, setDevice] = useState('desktop');
  const [widePreview, setWidePreview] = useState(false);
  const [editorTab, setEditorTab] = useState('item');
  const [resetKey, setResetKey] = useState(0);
  // Survives the remount that follows a successful save/publish.
  const [notice, setNotice] = useState(null);

  const pickers = useMemo(() => ({
    // A "collection" link resolves /collections/<slug>, which the storefront
    // and the server both accept for categories too (TOPS -> the "tops"
    // category). Listing only collections flagged every category link as
    // "not found".
    COLLECTION: {
      status: collections.status === 'ready' && categories.status === 'ready' ? 'ready' : (collections.status === 'error' || categories.status === 'error' ? 'error' : 'loading'),
      options: [
        // [slug, shown in the list, id, entity type, entity name]
        ...(collections.data?.collections ?? []).filter((c) => c.status === 'ACTIVE').map((c) => [c.slug, c.name, c.id, 'COLLECTION', c.name]),
        ...(categories.data?.categories ?? []).filter((c) => c.status === 'ACTIVE').map((c) => [c.slug, `${c.name} (category)`, c.id, 'CATEGORY', c.name]),
      ],
    },
    CATEGORY: { status: categories.status, options: (categories.data?.categories ?? []).filter((c) => c.status === 'ACTIVE').map((c) => [c.slug, c.name, c.id, 'CATEGORY', c.name]) },
    CONTENT_PAGE: { status: pages.status, options: (pages.data?.pages ?? []).map((p) => [p.slug, p.title, p.id, 'PAGE', p.title]) },
    PRODUCT: { status: products.status, options: (products.data?.products ?? []).map((p) => [p.slug, p.name]) },
  }), [collections.status, collections.data, categories.status, categories.data, pages.status, pages.data, products.status, products.data]);

  // Slugs of ACTIVE collections + categories: a link to anything else is
  // hidden by the storefront, so the editor flags it. Null until loaded.
  const activeSlugs = useMemo(
    () => (pickers.COLLECTION.status === 'ready' ? new Set(pickers.COLLECTION.options.map(([slug]) => slug)) : null),
    [pickers],
  );
  // Live names of everything a link can point at — the preview and lists show
  // these, exactly as the website does.
  const entities = useMemo(() => (collections.status === 'ready' && categories.status === 'ready'
    ? M.buildEntityIndex({
      collections: collections.data?.collections ?? [],
      categories: categories.data?.categories ?? [],
      pages: pages.data?.pages ?? [],
    })
    : null), [collections.status, collections.data, categories.status, categories.data, pages.data]);
  // Archived (switched off) vs deleted: a link to an archived category comes
  // back when it is switched on; a link to a deleted one should be removed.
  const archivedSlugs = useMemo(() => {
    if (collections.status !== 'ready' || categories.status !== 'ready') return null;
    return new Set([
      ...(collections.data?.collections ?? []).filter((c) => c.status !== 'ACTIVE').map((c) => c.slug),
      ...(categories.data?.categories ?? []).filter((c) => c.status !== 'ACTIVE').map((c) => c.slug),
    ]);
  }, [collections.status, collections.data, categories.status, categories.data]);

  if (res.status === 'loading') return <HeaderBuilderSkeleton />;
  if (res.status === 'error') return <ErrorState message={res.error?.message} onRetry={res.reload} />;

  const { nav, mega } = res.data;
  return (
    <HeaderBuilderInner
      key={`${nav.document.workingVersion}.${mega.document.workingVersion}.${resetKey}`}
      data={res.data} reload={res.reload} pickers={pickers}
      canWrite={canWrite} canPublish={canPublish}
      selection={selection} onSelect={setSelection}
      device={device} onDevice={setDevice}
      widePreview={widePreview} onWidePreview={setWidePreview}
      onDiscard={() => { setNotice(null); setResetKey((k) => k + 1); }}
      notice={notice} setNotice={setNotice}
      editorTab={editorTab} onEditorTab={setEditorTab}
      activeSlugs={activeSlugs}
      archivedSlugs={archivedSlugs}
      entities={entities}
    />
  );
}

function HeaderBuilderSkeleton() {
  return (
    <div className="hb" aria-busy="true">
      <div className="hb-top"><Skeleton height={20} width={220} /><Skeleton height={14} width={420} style={{ marginTop: 8 }} /></div>
      <div className="hb-layout">
        <div className="hb-col"><Skeleton lines={5} height={44} /></div>
        <div className="hb-col"><Skeleton height={520} /></div>
      </div>
    </div>
  );
}

const menuSig = (m) => ({ name: m.name, status: m.status, promoMediaId: m.promoMediaId || null, payload: M.serializeMenu(m) });

function HeaderBuilderInner({
  data, reload, pickers, canWrite, canPublish, selection, onSelect, device, onDevice, widePreview, onWidePreview, onDiscard,
  notice, setNotice, editorTab, onEditorTab, activeSlugs, archivedSlugs, entities,
}) {
  const [navItems, setNavItems] = useState(() => data.nav.items.map(M.hydrateNavItem));
  const [menus, setMenus] = useState(() => Object.fromEntries(data.mega.megaMenus.map((m) => [m.menuKey, M.hydrateMenu(m)])));
  const [settings, setSettings] = useState(() => M.hydrateSettings(data.nav.settings));
  const [base, setBase] = useState(() => ({
    nav: Object.fromEntries(data.nav.items.map((it) => [it.id, M.serializeNavItem(M.hydrateNavItem(it))])),
    order: data.nav.items.map((it) => it.id),
    menus: Object.fromEntries(data.mega.megaMenus.map((m) => [m.menuKey, menuSig(M.hydrateMenu(m))])),
    settings: M.serializeSettings(M.hydrateSettings(data.nav.settings)),
  }));
  const [deleted, setDeleted] = useState([]);
  const [versions, setVersions] = useState({ nav: data.nav.document.workingVersion, mega: data.mega.document.workingVersion });
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [uiOverride, setUiOverride] = useState(null);

  const slides = useMemo(() => M.announcementSlides(data.ann.announcements), [data.ann]);

  // ---- dirty tracking ----------------------------------------------------
  const itemDirty = (it) => it.isNew || !M.same(M.serializeNavItem(it), base.nav[it.id]);
  const menuDirty = (m) => m.isNew || !M.same(menuSig(m), base.menus[m.menuKey]);
  const settingsDirty = !M.same(M.serializeSettings(settings), base.settings);
  const orderDirty = !M.same(navItems.map((it) => it.id), base.order.filter((id) => !deleted.includes(id)));
  const dirtyCount = navItems.filter(itemDirty).length + Object.values(menus).filter(menuDirty).length
    + (settingsDirty ? 1 : 0) + deleted.length + (orderDirty && !navItems.some((it) => it.isNew) ? 1 : 0);
  const anyDirty = dirtyCount > 0;
  // Item pills compare content; the ORDER of the bar is compared here.
  const publishedOrder = (data.pubNav?.items || []).map((i) => i.id);
  const draftOrder = navItems.filter((it) => it.status === 'ACTIVE').map((it) => it.itemKey);
  const orderUnpublished = !M.same(
    draftOrder.filter((k) => publishedOrder.includes(k)),
    publishedOrder.filter((k) => draftOrder.includes(k)),
  );
  useUnsavedGuard(anyDirty);

  // ---- validation --------------------------------------------------------
  const referenced = new Set(navItems.map((it) => it.megaMenuKey).filter(Boolean));
  const itemErrors = Object.fromEntries(navItems.map((it) => [it._k, M.validateNavItem(it, menus)]));
  const menuErrors = Object.fromEntries(Object.values(menus).map((m) => [m.menuKey, (referenced.has(m.menuKey) || menuDirty(m)) ? M.validateMenu(m) : []]));
  const settingsErrors = M.validateSettings(settings);
  const problemCount = Object.values(itemErrors).reduce((n, e) => n + e.length, 0)
    + Object.values(menuErrors).reduce((n, e) => n + e.length, 0) + settingsErrors.length;

  // ---- selection + preview -----------------------------------------------
  const selectedItem = selection?.kind === 'item' ? navItems.find((it) => it.itemKey === selection.key) : null;
  const effectiveSelection = selectedItem ? selection : (selection?.kind === 'mobile' ? selection : (navItems[0] ? { kind: 'item', key: navItems[0].itemKey } : { kind: 'mobile' }));
  const current = effectiveSelection.kind === 'item' ? navItems.find((it) => it.itemKey === effectiveSelection.key) : null;
  const currentMenu = current?.megaMenuKey ? menus[current.megaMenuKey] : null;

  const select = (next) => { setUiOverride(null); onSelect(next); };

  const isMobileWidth = (d) => (PREVIEW_DEVICES[d]?.width ?? 1440) <= MOBILE_UI_MAX_WIDTH;
  const mobileUi = isMobileWidth(device);
  // One menu for every screen: switching the preview size only changes how
  // the same menu is shown (dropdown on desktop, submenu on tablet/mobile).
  const changeTab = (next) => { setUiOverride(null); onEditorTab(next); };
  const changeDevice = (next) => { setUiOverride(null); onDevice(next); };
  const expandable = (m) => Boolean(m && m.status === 'ACTIVE' && m.categoryItems.some((l) => !l.hidden) && (m.mobileExpand ?? m.panel !== 'drops'));
  const derivedUi = mobileUi
    ? { mobileOpen: true, mobileCategoryId: current && current.status === 'ACTIVE' && expandable(currentMenu) ? current.itemKey : null, openMenuId: null }
    : { mobileOpen: false, openMenuId: current && current.status === 'ACTIVE' && currentMenu?.status === 'ACTIVE' ? current.itemKey : null, pinMenu: true };
  const ui = uiOverride ? { ...derivedUi, ...uiOverride } : derivedUi;

  // Rebuilt every render; LivePreview only posts when its content changes.
  const previewMessage = {
    type: 'header',
    data: M.buildPreviewHeader({ navItems, menus, settings, slides, activeSlugs, entities }),
    ui,
  };

  const onPreviewUi = (patch) => {
    if (patch.openMenuId) {
      const hit = navItems.find((it) => it.itemKey === patch.openMenuId);
      if (hit) { select({ kind: 'item', key: hit.itemKey }); return; }
    }
    if ('mobileCategoryId' in patch) {
      const hit = patch.mobileCategoryId ? navItems.find((it) => it.itemKey === patch.mobileCategoryId) : null;
      if (hit) { select({ kind: 'item', key: hit.itemKey }); return; }
      setUiOverride((cur) => ({ ...(cur || {}), mobileCategoryId: null }));
    }
    if ('mobileOpen' in patch) setUiOverride((cur) => ({ ...(cur || {}), mobileOpen: patch.mobileOpen }));
  };

  // ---- mutations (local) -------------------------------------------------
  const patchItem = (k, part) => setNavItems((cur) => cur.map((it) => (it._k === k ? { ...it, ...part } : it)));
  const patchMenu = (key, next) => setMenus((cur) => ({ ...cur, [key]: next }));

  const addItem = () => {
    const taken = new Set(navItems.map((it) => it.itemKey));
    const itemKey = M.slugKey('new item', 'nav', taken);
    const item = { _k: `new-${itemKey}`, id: `new-${itemKey}`, itemKey, isNew: true, label: 'NEW ITEM', linkType: 'COLLECTION', linkTarget: '', externalUrl: '', megaMenuKey: '', icon: 'apps', status: 'ACTIVE' };
    setNavItems((cur) => [...cur, item]);
    select({ kind: 'item', key: itemKey });
  };

  const removeItem = (it) => {
    if (!window.confirm(`Remove "${it.label || 'this item'}" from the header? It disappears from the live site when you publish.`)) return;
    setNavItems((cur) => cur.filter((x) => x._k !== it._k));
    if (!it.isNew) setDeleted((d) => [...d, it.id]);
    select(null);
  };

  const createMenuFor = (it) => {
    const key = M.slugKey(it.label || 'menu', 'mega', new Set(Object.keys(menus)));
    setMenus((cur) => ({ ...cur, [key]: M.newMenu(key, it.label, M.navRoute(it), it.icon) }));
    patchItem(it._k, { megaMenuKey: key });
  };

  // ---- save draft ----------------------------------------------------------
  const save = async () => {
    setActionError(null); setNotice(null); setSaving(true);
    let navV = versions.nav;
    let megaV = versions.mega;
    const working = [...navItems];
    let serverOrder = base.order.filter((id) => !deleted.includes(id));
    try {
      // Dropdowns first: a bar item may point at a dropdown created in this session.
      for (const m of Object.values(menus)) {
        if (!menuDirty(m)) continue;
        const r = await adminApi.content.upsertMegaMenu({
          menuKey: m.menuKey, name: m.name, status: m.status, promoMediaId: m.promoMediaId || null,
          payload: M.serializeMenu(m), expectedVersion: megaV,
        });
        megaV = r.document.workingVersion;
        const saved = { ...m, isNew: false };
        setMenus((cur) => ({ ...cur, [m.menuKey]: saved }));
        setBase((b) => ({ ...b, menus: { ...b.menus, [m.menuKey]: menuSig(saved) } }));
      }
      for (const id of deleted) {
        const r = await adminApi.content.deleteNavItem(id, navV);
        navV = r.document.workingVersion;
        serverOrder = r.items.map((x) => x.id);
        setDeleted((d) => d.filter((x) => x !== id));
      }
      for (let i = 0; i < working.length; i += 1) {
        const it = working[i];
        if (!itemDirty(it)) continue;
        const r = await adminApi.content.upsertNavItem({
          ...M.serializeNavItem(it), expectedVersion: navV, ...(it.isNew ? { itemKey: it.itemKey } : { id: it.id }),
        });
        navV = r.document.workingVersion;
        serverOrder = r.items.map((x) => x.id);
        const serverItem = r.items.find((x) => x.itemKey === it.itemKey);
        const saved = { ...it, id: serverItem.id, isNew: false };
        working[i] = saved;
        setNavItems((cur) => cur.map((x) => (x._k === it._k ? saved : x)));
        setBase((b) => ({ ...b, nav: { ...b.nav, [saved.id]: M.serializeNavItem(saved) }, order: serverOrder }));
      }
      const wanted = working.map((x) => x.id);
      if (!M.same(wanted, serverOrder)) {
        const r = await adminApi.content.reorderNav(wanted, null, navV);
        navV = r.document.workingVersion;
        setBase((b) => ({ ...b, order: wanted }));
      }
      if (settingsDirty) {
        const r = await adminApi.content.setNavigationSettings(M.serializeSettings(settings), navV);
        navV = r.document.workingVersion;
        setBase((b) => ({ ...b, settings: M.serializeSettings(settings) }));
      }
      setVersions({ nav: navV, mega: megaV });
      setNotice('Draft saved. Customers still see the published header until you publish.');
      reload();
    } catch (err) {
      // Everything saved before the failure is kept (and no longer marked
      // unsaved); the rest stays in the editor to fix and save again.
      setVersions({ nav: navV, mega: megaV });
      setActionError(err);
    } finally {
      setSaving(false);
    }
  };

  // ---- publish -------------------------------------------------------------
  const navDoc = data.nav.document;
  const megaDoc = data.mega.document;
  const unpublished = navDoc.draftDirty || megaDoc.draftDirty;
  const publish = async () => {
    setActionError(null); setNotice(null); setPublishing(true);
    try {
      if (megaDoc.draftDirty) await adminApi.content.publish('mega-menus', megaDoc.workingVersion);
      if (navDoc.draftDirty) await adminApi.content.publish('navigation', navDoc.workingVersion);
      setNotice('Published. The live header now matches this draft.');
      reload();
    } catch (err) {
      setActionError(err);
    } finally {
      setPublishing(false);
    }
  };

  const unused = Object.values(menus).filter((m) => !referenced.has(m.menuKey));
  const headerStatus = anyDirty ? { tone: 'warn', label: `${dirtyCount} unsaved change${dirtyCount === 1 ? '' : 's'}` }
    : unpublished ? { tone: 'info', label: 'Saved draft — not published' }
      : { tone: 'good', label: 'Live — matches the website' };

  return (
    <div className="hb">
      <div className="hb-top">
        <div className="hb-top__text">
          <h2 className="hb-top__title">Header &amp; navigation</h2>
          <ol className="hb-steps" aria-label="How it works">
            <li><span>1</span>Pick an item on the left</li>
            <li><span>2</span>Edit — the preview updates as you type</li>
            <li className={anyDirty ? 'hb-steps__now' : ''}><span>3</span>Save draft</li>
            <li className={!anyDirty && unpublished ? 'hb-steps__now' : ''}><span>4</span>Publish header — customers see it</li>
          </ol>
        </div>
        <div className="hb-top__actions">
          <span className={`hb-status hb-status--${headerStatus.tone}`} role="status">{headerStatus.label}</span>
          {canWrite && <Button variant="secondary" disabled={!anyDirty || saving} onClick={() => { if (window.confirm('Discard all unsaved header changes?')) onDiscard(); }}>Discard</Button>}
          {canWrite && <Button busy={saving} disabled={!anyDirty || problemCount > 0} onClick={save}>Save draft</Button>}
          {canPublish && <Button variant="success" busy={publishing} disabled={anyDirty || !unpublished} onClick={publish} title={anyDirty ? 'Save your changes first' : undefined}>Publish header</Button>}
        </div>
      </div>

      {problemCount > 0 && anyDirty && <InlineAlert tone="warning">{problemCount} problem{problemCount === 1 ? '' : 's'} to fix before saving — marked in red below.</InlineAlert>}
      {actionError && <InlineAlert tone="error">{actionError.message}</InlineAlert>}
      {notice && !actionError && <InlineAlert tone="success">{notice}</InlineAlert>}

      <div className={`hb-layout${widePreview ? ' hb-layout--wide' : ''}`}>
        <div className="hb-col hb-col--edit">
          <section className="hb-panel" aria-labelledby="hb-structure-title">
            <div className="hb-panel__head">
              <h3 id="hb-structure-title" className="hb-panel__title">Header bar</h3>
              <span className="hb-panel__hint">Drag to reorder</span>
            </div>
            <div className="hb-bar-logo" aria-hidden="true">CORCOTTON™ logo · always first</div>
            <SortableList
              label="Header menu items"
              items={navItems}
              getKey={(it) => it._k}
              disabled={!canWrite}
              onReorder={setNavItems}
              renderItem={(it, i, { handleProps }) => {
                const state = M.navItemState(it, data.pubNav);
                const menu = it.megaMenuKey ? menus[it.megaMenuKey] : null;
                const errs = (itemErrors[it._k]?.length || 0) + (menu ? (menuErrors[menu.menuKey]?.length || 0) : 0);
                const active = current?._k === it._k;
                return (
                  <div className={`hb-item${active ? ' hb-item--active' : ''}${it.status !== 'ACTIVE' ? ' hb-item--off' : ''}`}>
                    <DragHandle {...handleProps} disabled={!canWrite} />
                    <button type="button" className="hb-item__main" aria-current={active || undefined} onClick={() => select({ kind: 'item', key: it.itemKey })}>
                      <span className="hb-item__label">{M.shownLabel(M.navLink(it), entities) || 'Untitled'}</span>
                      <span className="hb-item__meta">
                        {menu ? `Dropdown · ${menu.categoryItems.filter((r) => !r.hidden).length} links` : 'Plain link'}
                        {itemDirty(it) || (menu && menuDirty(menu)) ? <span className="hb-dot" title="Unsaved changes" /> : null}
                      </span>
                    </button>
                    {errs > 0 && <span className="hb-item__errors" title={`${errs} problem(s)`}>{errs}</span>}
                    <StatePill state={state} menuState={menu ? M.menuState(menu, data.pubMega) : null} compact />
                    {canWrite && (
                      <button type="button" className="hb-icon-btn" aria-label={it.status === 'ACTIVE' ? `Hide ${it.label}` : `Show ${it.label}`}
                        aria-pressed={it.status === 'ACTIVE'}
                        onClick={() => patchItem(it._k, { status: it.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' })}>
                        {it.status === 'ACTIVE' ? <EyeIcon /> : <EyeOffIcon />}
                      </button>
                    )}
                  </div>
                );
              }}
            />
            {canWrite && <button type="button" className="hb-add" onClick={addItem}>+ Add menu item</button>}
            <div className="hb-locked" title="Part of the header, not content">
              <span>Search · Account · Wishlist · Bag</span>
              <span className="hb-locked__note">Always shown on the right — not editable here</span>
            </div>
            {orderDirty && <p className="hb-panel__note">Order changed — save to keep it.</p>}
            {!orderDirty && orderUnpublished && <p className="hb-panel__note">Saved order is not published yet — customers still see the old order.</p>}
          </section>

          <section className="hb-panel" aria-labelledby="hb-mobile-title">
            <div className="hb-panel__head">
              <h3 id="hb-mobile-title" className="hb-panel__title">Mobile menu</h3>
            </div>
            <button type="button" className={`hb-item hb-item--row${effectiveSelection.kind === 'mobile' ? ' hb-item--active' : ''}`}
              onClick={() => { select({ kind: 'mobile' }); if (!mobileUi) onDevice('mobile'); }}>
              <span className="hb-item__main hb-item__main--static">
                <span className="hb-item__label">Links &amp; tagline</span>
                <span className="hb-item__meta">
                  {settings.mobileLinks.filter((l) => !l.hidden).length} links · “{settings.mobileTagline || 'no tagline'}”
                  {settingsDirty ? <span className="hb-dot" title="Unsaved changes" /> : null}
                </span>
              </span>
              {settingsErrors.length > 0 && <span className="hb-item__errors">{settingsErrors.length}</span>}
            </button>
            <p className="hb-panel__note">Each item’s tablet and mobile submenu is its dropdown’s category links — the same menu as desktop.</p>
          </section>

          {unused.length > 0 && (
            <section className="hb-panel" aria-labelledby="hb-unused-title">
              <div className="hb-panel__head"><h3 id="hb-unused-title" className="hb-panel__title">Dropdowns not attached to any item</h3></div>
              <ul className="hb-unused">
                {unused.map((m) => <li key={m.menuKey}><span>{m.name}</span><span className="hb-panel__hint">{m.menuKey}</span></li>)}
              </ul>
              <p className="hb-panel__note">Attach one from an item’s “Dropdown” setting. Unattached dropdowns are never shown.</p>
            </section>
          )}

          {current && (
            <ItemEditor
              key={current._k}
              item={current}
              menu={currentMenu}
              menus={menus}
              pickers={pickers}
              canWrite={canWrite}
              itemErrors={itemErrors[current._k] || []}
              menuErrors={currentMenu ? (menuErrors[currentMenu.menuKey] || []) : []}
              itemState={M.navItemState(current, data.pubNav)}
              menuState={currentMenu ? M.menuState(currentMenu, data.pubMega) : null}
              sharedBy={currentMenu ? navItems.filter((it) => it.megaMenuKey === currentMenu.menuKey && it._k !== current._k).map((it) => it.label) : []}
              tab={editorTab}
              onTab={changeTab}
              activeSlugs={activeSlugs}
              archivedSlugs={archivedSlugs}
              entities={entities}
              onItemChange={(part) => {
                patchItem(current._k, part);
                // One icon: the item's icon is also its dropdown links' icon.
                if ('icon' in part && currentMenu) patchMenu(currentMenu.menuKey, { ...currentMenu, categoryIcon: part.icon });
              }}
              onMenuChange={(next) => patchMenu(next.menuKey, next)}
              onRemove={() => removeItem(current)}
              onCreateMenu={() => { createMenuFor(current); changeTab('dropdown'); }}
            />
          )}
          {effectiveSelection.kind === 'mobile' && (
            <MobileMenuEditor settings={settings} canWrite={canWrite} errors={settingsErrors} onChange={setSettings} pickers={pickers} activeSlugs={activeSlugs} archivedSlugs={archivedSlugs} entities={entities} />
          )}
        </div>

        <div className="hb-col hb-col--preview">
          <div className="hb-preview-sticky">
            <LivePreview
              title="Header preview"
              message={previewMessage}
              device={device}
              onDeviceChange={changeDevice}
              devices={['desktop', 'tablet', 'mobile']}
              height={widePreview ? 560 : 640}
              onUi={onPreviewUi}
            />
            <div className="hb-preview-foot">
              <span>{mobileUi ? 'Showing the mobile menu' : current?.megaMenuKey ? `Holding the “${current.label}” dropdown open` : 'Hover a menu in the preview to open it'}</span>
              <button type="button" className="linkish" onClick={() => onWidePreview(!widePreview)}>{widePreview ? 'Side-by-side' : 'Wide preview'}</button>
            </div>
          </div>
        </div>
      </div>

      <details className="hb-history">
        <summary>Version history &amp; rollback</summary>
        <p className="hb-panel__note">The header publishes as two parts — dropdowns and the bar. Rolling back one restores that part’s draft and republishes it.</p>
        <PublishBar scope="mega-menus" doc={megaDoc} canPublish={canPublish} onDone={reload} />
        <PublishBar scope="navigation" doc={navDoc} canPublish={canPublish} onDone={reload} />
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

export default HeaderBuilder;
