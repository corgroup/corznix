import { useId, useState } from 'react';
import { MediaPicker } from '../../../components/media/MediaPicker.jsx';
import { SortableList, DragHandle } from '../../../components/ui/SortableList.jsx';
import { makeRowKey } from '../../../components/ui/rowHelpers.js';
import * as M from './headerModel.js';

// Editors for the Header builder. Every control writes straight into the
// draft state the live preview renders, so each keystroke shows there.
//
// One menu everywhere: there is no separate mobile or tablet list. A
// dropdown's category links are its desktop links, its mobile/tablet submenu
// and its category cards; its promo panel is also the mobile promo card.

const STATE_TONE = { live: 'good', changed: 'info', new: 'info', pending: 'info', off: 'muted', 'going-off': 'warn' };
const SHORT_STATE = { live: 'Live', off: 'Off', new: 'New', pending: 'Not live yet', 'going-off': 'Turning off', changed: 'Changed' };

export function StatePill({ state, menuState, compact = false }) {
  // An item is only as live as the worse of itself and its dropdown.
  const shown = state === 'live' && menuState && menuState !== 'live' && menuState !== 'off' ? menuState : state;
  const label = M.STATE_LABELS[shown];
  return (
    <span className={`hb-pill hb-pill--${STATE_TONE[shown]}${compact ? ' hb-pill--compact' : ''}`} title={label}>
      {compact ? SHORT_STATE[shown] : label}
    </span>
  );
}

function Counter({ value, max }) {
  const n = (value || '').length;
  return <span className={`hb-counter${n > max ? ' hb-counter--over' : ''}`}>{n}/{max}</span>;
}

export function TextField({ label, value, onChange, max, disabled, placeholder, multiline = false, hint, invalid = false }) {
  const id = useId();
  const common = {
    id, value, disabled, placeholder, 'aria-invalid': invalid || undefined,
    onChange: (e) => onChange(e.target.value),
    className: `hb-input${invalid ? ' hb-input--invalid' : ''}`,
  };
  return (
    <div className="hb-field">
      <div className="hb-field__label-row">
        <label htmlFor={id}>{label}</label>
        {max ? <Counter value={value} max={max} /> : null}
      </div>
      {multiline ? <textarea rows={2} {...common} /> : <input type="text" {...common} />}
      {hint && <p className="hb-field__hint">{hint}</p>}
    </div>
  );
}

const PATH_SUGGESTIONS_ID = 'hb-path-suggestions';

export function PathSuggestions({ pickers }) {
  const opts = [
    ...(pickers.COLLECTION?.options || []).map(([slug, name]) => [`/collections/${slug}`, name]),
    ...(pickers.CONTENT_PAGE?.options || []).map(([slug, name]) => [`/pages/${slug}`, name]),
    ['/collections', 'All collections'], ['/size-guide', 'Size guide'], ['/help', 'Help & support'], ['/search', 'Search'],
  ];
  const seen = new Set();
  return (
    <datalist id={PATH_SUGGESTIONS_ID}>
      {opts.filter(([p]) => (seen.has(p) ? false : seen.add(p))).map(([p, name]) => <option key={p} value={p}>{name}</option>)}
    </datalist>
  );
}

function PathField({ label = 'Link', value, onChange, disabled, placeholder = '/collections/…', hint, activeSlugs, archivedSlugs }) {
  const id = useId();
  const bad = !M.isValidPath(value);
  const retired = !bad && M.retiredKind(value, activeSlugs, archivedSlugs);
  return (
    <div className="hb-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="text" className={`hb-input hb-input--path${bad ? ' hb-input--invalid' : ''}${retired ? ' hb-input--warn' : ''}`} list={PATH_SUGGESTIONS_ID}
        value={value} disabled={disabled} placeholder={placeholder} aria-invalid={bad || undefined}
        onChange={(e) => onChange(e.target.value)} />
      <p className={`hb-field__hint${retired ? ' hb-field__hint--warn' : ''}`}>
        {bad ? 'Start with "/" (pick a suggestion) or https://'
          : retired === 'archived' ? 'This collection or category is switched off in the catalog, so this link is hidden everywhere until it is switched back on.'
            : retired === 'deleted' ? 'Nothing exists at this address any more (the collection or category was deleted) — remove this link or choose another destination.'
            : hint || 'Type or pick a page from the suggestions.'}
      </p>
    </div>
  );
}

export function Errors({ errors }) {
  if (!errors.length) return null;
  return (
    <ul className="hb-errors" role="alert">
      {errors.map((e) => <li key={e}>{e}</li>)}
    </ul>
  );
}

export function Toggle({ checked, onChange, label, disabled, hint }) {
  const id = useId();
  return (
    <div className="hb-toggle">
      <input id={id} type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <label htmlFor={id}><span className="hb-toggle__track" aria-hidden="true"><span className="hb-toggle__thumb" /></span>{label}</label>
      {hint && <p className="hb-field__hint">{hint}</p>}
    </div>
  );
}

export function Segment({ label, value, options, onChange, disabled }) {
  return (
    <div className="hb-field">
      <span className="hb-field__label">{label}</span>
      <div className="hb-segment" role="radiogroup" aria-label={label}>
        {options.map(([v, l]) => (
          <button key={v} type="button" role="radio" aria-checked={value === v} disabled={disabled}
            className={`hb-segment__opt${value === v ? ' hb-segment__opt--on' : ''}`} onClick={() => onChange(v)}>{l}</button>
        ))}
      </div>
    </div>
  );
}

function Swatches({ label, value, onChange, disabled, small = false }) {
  return (
    <div className="hb-field">
      <span className="hb-field__label">{label}</span>
      <div className="hb-swatches" role="radiogroup" aria-label={label}>
        {M.BACKGROUND_PRESETS.map(([name, css]) => (
          <button key={name} type="button" role="radio" aria-checked={value === css} disabled={disabled}
            className={`hb-swatch${small ? ' hb-swatch--sm' : ''}${value === css ? ' hb-swatch--on' : ''}`} style={{ background: css }}
            title={name} aria-label={name} onClick={() => onChange(css)} />
        ))}
      </div>
    </div>
  );
}

// ---- compact, sortable rows ----------------------------------------------------

function RowsSection({ title, hint, rows, onRows, max, disabled, makeRow, summary, renderFields, addLabel, emptyLabel }) {
  const [open, setOpen] = useState(() => new Set());
  const patch = (k, part) => onRows(rows.map((r) => (r._k === k ? { ...r, ...part } : r)));
  const toggle = (k) => setOpen((cur) => { const n = new Set(cur); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const add = () => {
    const r = { _k: makeRowKey(), hidden: false, ...makeRow() };
    onRows([...rows, r]);
    setOpen((cur) => new Set(cur).add(r._k));
  };
  return (
    <div className="hb-rows">
      <div className="hb-rows__head">
        <span className="hb-rows__title">{title}</span>
        <span className="hb-panel__hint">{rows.length}/{max} · drag to reorder</span>
      </div>
      {hint && <p className="hb-field__hint">{hint}</p>}
      {rows.length === 0 && <p className="hb-rows__empty">{emptyLabel}</p>}
      <SortableList
        label={title}
        items={rows}
        getKey={(r) => r._k}
        disabled={disabled}
        onReorder={onRows}
        renderItem={(r, i, { handleProps }) => {
          const s = summary(r);
          const isOpen = open.has(r._k);
          return (
            <div className={`hb-row${r.hidden || s.retired ? ' hb-row--hidden' : ''}${s.invalid ? ' hb-row--invalid' : ''}${isOpen ? ' hb-row--open' : ''}`}>
              <div className="hb-row__line">
                <DragHandle {...handleProps} disabled={disabled} />
                <button type="button" className="hb-row__summary" aria-expanded={isOpen} onClick={() => toggle(r._k)}>
                  <span className="hb-row__title">{s.title || <em>Untitled</em>}</span>
                  <span className="hb-row__sub">{s.sub}</span>
                  {s.badge && <span className="hb-badge">{s.badge}</span>}
                  {s.retired === 'archived' && <span className="hb-badge hb-badge--warn" title="Switched off in the catalog — hidden until switched back on">Category off</span>}
                  {s.retired === 'deleted' && <span className="hb-badge hb-badge--danger" title="The collection or category was deleted — remove this link">Deleted</span>}
                  {s.invalid && <span className="hb-row__warn">Needs attention</span>}
                  <span className="hb-row__chev" aria-hidden="true">{isOpen ? '▴' : '▾'}</span>
                </button>
                <button type="button" className={`hb-chip-btn${r.hidden ? ' hb-chip-btn--off' : ''}`} disabled={disabled}
                  aria-pressed={!r.hidden} aria-label={`${r.hidden ? 'Show' : 'Hide'} ${s.title || 'row'}`}
                  onClick={() => patch(r._k, { hidden: !r.hidden })}>
                  {r.hidden ? 'Hidden' : 'Shown'}
                </button>
                <button type="button" className="hb-icon-btn hb-icon-btn--danger" disabled={disabled} aria-label={`Remove ${s.title || 'row'}`}
                  onClick={() => onRows(rows.filter((x) => x._k !== r._k))}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></svg>
                </button>
              </div>
              {isOpen && <div className="hb-row__edit">{renderFields(r, (part) => patch(r._k, part), i)}</div>}
            </div>
          );
        }}
      />
      {!disabled && (
        <button type="button" className="hb-add" disabled={rows.length >= max} onClick={add}>
          {rows.length >= max ? `Limit of ${max} reached` : addLabel}
        </button>
      )}
    </div>
  );
}

const TYPE_NOUN = { CATEGORY: 'category', COLLECTION: 'collection', PAGE: 'page' };

const linkSummary = (r, activeSlugs, entities, archivedSlugs) => {
  const entity = M.entityOf(r, entities);
  return {
    title: M.shownLabel(r, entities),
    sub: entity ? `${TYPE_NOUN[entity.type]} · ${M.entityRoute(entity)}` : ((r.path || '').trim() ? `→ ${r.path.trim()}` : '→ no link yet'),
    invalid: !M.shownLabel(r, entities) || !M.isValidPath(r.path),
    retired: M.isValidPath(r.path) ? M.retiredKind(r.path, activeSlugs, archivedSlugs) : null,
  };
};

// Where a link goes: one of the website's collections, categories or pages
// (a reference — its name and URL stay in sync), or a custom path.
// purpose="button": a button's destination — the button keeps its own text,
// so there is no name to type and nothing is shown "as" the entity's name.
// purpose="message": an announcement's link — the message keeps its own words;
// optional: "no link" is a valid choice.
export function EntityLinkField({ row, onPatch, pickers, entities, activeSlugs, archivedSlugs, disabled, customLabelMax = M.LIMITS.itemLabel, placeholder, purpose = 'link', optional = false }) {
  const id = useId();
  const entity = M.entityOf(row, entities);
  const [custom, setCustom] = useState(() => !entity && Boolean((row.path || '').trim()));
  const catalog = pickers.COLLECTION?.options || [];
  const pages = pickers.CONTENT_PAGE?.options || [];
  const value = entity ? `${entity.type}:${entity.id}` : (custom ? 'custom' : '');
  const choose = (v) => {
    if (v === 'custom') { setCustom(true); onPatch({ ref: null }); return; }
    if (!v) { setCustom(false); onPatch({ ref: null, path: '' }); return; }
    const e = entities?.byId.get(v);
    if (e) { setCustom(false); onPatch({ ref: { type: e.type, id: e.id }, path: M.entityRoute(e), label: e.name }); }
  };
  return (
    <>
      <div className="hb-field">
        <label htmlFor={id}>Links to</label>
        <select id={id} className={`hb-input${!value && !optional ? ' hb-input--invalid' : ''}`} value={value} disabled={disabled || !entities} onChange={(e) => choose(e.target.value)}>
          <option value="">{entities ? (optional ? 'No link' : '— choose —') : 'Loading…'}</option>
          {/* The current destination is switched off, so it is not in the lists
              below — keep it selectable and say why it is hidden. */}
          {entity && !entity.active && (
            <option value={`${entity.type}:${entity.id}`}>{entity.name} (switched off — hidden on the website)</option>
          )}
          <optgroup label="Collections">
            {catalog.filter((o) => o[3] === 'COLLECTION').map((o) => <option key={`c-${o[2]}`} value={`COLLECTION:${o[2]}`}>{o[4]}</option>)}
          </optgroup>
          <optgroup label="Categories">
            {catalog.filter((o) => o[3] === 'CATEGORY').map((o) => <option key={`k-${o[2]}`} value={`CATEGORY:${o[2]}`}>{o[4]}</option>)}
          </optgroup>
          <optgroup label="Pages">
            {pages.map((o) => <option key={`p-${o[2]}`} value={`PAGE:${o[2]}`}>{o[4]}</option>)}
          </optgroup>
          <option value="custom">Custom path or URL…</option>
        </select>
      </div>
      {entity ? (
        <p className="hb-field__hint hb-grid__full">
          {purpose === 'button' ? (
            <>Opens the {TYPE_NOUN[entity.type]} <strong>“{entity.name}”</strong>. If its address changes the button follows it; if it is switched off or deleted the button is hidden.</>
          ) : purpose === 'message' ? (
            <>Opens the {TYPE_NOUN[entity.type]} <strong>“{entity.name}”</strong>. If its address changes the link follows it; if it is switched off or deleted the message shows without a link.</>
          ) : (
            <>Shows as <strong>“{M.shownLabel(row, entities)}”</strong> — the {TYPE_NOUN[entity.type]}’s own name. Rename it in {entity.type === 'PAGE' ? 'Pages' : entity.type === 'COLLECTION' ? 'Collections' : 'Categories'} and it changes everywhere.</>
          )}
        </p>
      ) : custom ? (
        <>
          {purpose === 'link' && <TextField label="Name" value={row.label} max={customLabelMax} disabled={disabled} invalid={!(row.label || '').trim()} onChange={(v) => onPatch({ label: v })} />}
          <div className="hb-grid__full"><PathField value={row.path} disabled={disabled} activeSlugs={activeSlugs} archivedSlugs={archivedSlugs} placeholder={placeholder} onChange={(v) => onPatch({ path: v })} /></div>
        </>
      ) : null}
    </>
  );
}

// ---- tabs + accordion -------------------------------------------------------------

function Tabs({ tabs, value, onChange, label }) {
  return (
    <div className="hb-tabs" role="tablist" aria-label={label}>
      {tabs.map(([k, l, count]) => (
        <button key={k} type="button" role="tab" aria-selected={value === k}
          className={`hb-tabs__tab${value === k ? ' hb-tabs__tab--on' : ''}`} onClick={() => onChange(k)}>
          {l}{count > 0 && <span className="hb-tabs__count" aria-label={`${count} problems`}>{count}</span>}
        </button>
      ))}
    </div>
  );
}

function Section({ id, title, hint, open, onOpen, children, count = 0 }) {
  return (
    <div className={`hb-card${open ? ' hb-card--open' : ''}`}>
      <button type="button" className="hb-card__summary" aria-expanded={open} aria-controls={id} onClick={onOpen}>
        <span className="hb-card__title">{title}</span>
        <span className="hb-panel__hint">{hint}</span>
        {count > 0 && <span className="hb-tabs__count">{count}</span>}
        <span className="hb-row__chev" aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {open && <div id={id} className="hb-card__body">{children}</div>}
    </div>
  );
}

// ---- the selected item ---------------------------------------------------------------

export function ItemEditor({
  item, menu, menus, pickers, activeSlugs, archivedSlugs, entities, canWrite, itemErrors, menuErrors, itemState, menuState, sharedBy,
  tab, onTab, onItemChange, onMenuChange, onRemove, onCreateMenu,
}) {
  const current = tab === 'dropdown' ? 'dropdown' : 'item';
  return (
    <section className="hb-panel hb-editor" aria-labelledby="hb-item-title">
      <PathSuggestions pickers={pickers} />
      <div className="hb-panel__head">
        <h3 id="hb-item-title" className="hb-panel__title">Editing: {M.shownLabel(M.navLink(item), entities) || 'Untitled'}</h3>
        <StatePill state={itemState} menuState={menuState} />
      </div>
      <Tabs label="Edit" value={current} onChange={onTab} tabs={[
        ['item', 'Menu item', itemErrors.length],
        ['dropdown', 'Dropdown', menuErrors.length],
      ]} />
      {current === 'item' && (
        <ItemBasics item={item} menus={menus} pickers={pickers} entities={entities} canWrite={canWrite} errors={itemErrors}
          onChange={onItemChange} onRemove={onRemove} onCreateMenu={onCreateMenu} />
      )}
      {current === 'dropdown' && (menu
        ? <Dropdown key={menu.menuKey} menu={menu} itemLabel={M.shownLabel(M.navLink(item), entities)} canWrite={canWrite} errors={menuErrors} sharedBy={sharedBy} activeSlugs={activeSlugs} archivedSlugs={archivedSlugs} entities={entities} pickers={pickers} onChange={onMenuChange} />
        : (
          <div className="hb-empty">
            <p>{item.label || 'This item'} has no dropdown: on desktop, tablet and mobile it is a plain link to its page.</p>
            {canWrite && <button type="button" className="hb-add" onClick={onCreateMenu}>+ Create a dropdown for this item</button>}
          </div>
        ))}
    </section>
  );
}

function ItemBasics({ item, menus, pickers, entities, canWrite, errors, onChange, onRemove, onCreateMenu }) {
  const disabled = !canWrite;
  const picker = pickers[item.linkType];
  const known = picker?.options?.some(([slug]) => slug === item.linkTarget);
  const typeId = useId();
  const menuId = useId();
  return (
    <div className="hb-tabpanel" role="tabpanel">
      <Errors errors={errors} />
      {item.linkRefId ? (
        <div className="hb-field">
          <span className="hb-field__label">Name in the header</span>
          <p className="hb-linked-name"><strong>{M.shownLabel(M.navLink(item), entities) || '—'}</strong></p>
          <p className="hb-field__hint">This is the name of the linked {item.linkRefType === 'PAGE' ? 'page' : item.linkRefType === 'COLLECTION' ? 'collection' : 'category'}. Rename it there and it changes in the header, dropdowns, mobile menu and footer at once.</p>
        </div>
      ) : (
        <TextField label="Name in the header" value={item.label} max={M.LIMITS.navLabel} disabled={disabled}
          invalid={!item.label.trim()} onChange={(v) => onChange({ label: v })} hint="Used on desktop, tablet and mobile. Shown in capitals." />
      )}

      <div className="hb-field">
        <label htmlFor={typeId}>Clicking it opens</label>
        <div className="hb-link">
          <select id={typeId} className="hb-input" value={item.linkType} disabled={disabled}
            onChange={(e) => onChange({ linkType: e.target.value, linkTarget: '', externalUrl: '', linkRefType: null, linkRefId: null })}>
            {M.LINK_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          {item.linkType === 'EXTERNAL' ? (
            <input type="url" className="hb-input" value={item.externalUrl} disabled={disabled} placeholder="https://…" aria-label="External address"
              onChange={(e) => onChange({ externalUrl: e.target.value })} />
          ) : M.NO_TARGET_LINKS.has(item.linkType) ? (
            <span className="hb-link__none">No destination needed</span>
          ) : M.PICKER_LINKS.has(item.linkType) && picker?.status === 'ready' ? (
            <select className="hb-input" value={item.linkTarget} disabled={disabled} aria-label="Destination" onChange={(e) => {
              const opt = picker.options.find(([slug]) => slug === e.target.value);
              // Picking an entity links to the entity itself and uses its name.
              onChange(opt && opt[2]
                ? { linkTarget: opt[0], linkRefType: opt[3], linkRefId: opt[2], label: opt[4] }
                : { linkTarget: e.target.value, linkRefType: null, linkRefId: null });
            }}>
              <option value="">— choose —</option>
              {item.linkTarget && !known && <option value={item.linkTarget}>{item.linkTarget} (switched off or deleted — not shown)</option>}
              {picker.options.map(([slug, name]) => <option key={slug} value={slug}>{name}</option>)}
            </select>
          ) : (
            <input type="text" className="hb-input" value={item.linkTarget} disabled={disabled}
              placeholder={item.linkType === 'CUSTOM_INTERNAL' ? '/path' : 'slug'} aria-label="Destination"
              onChange={(e) => onChange({ linkTarget: e.target.value })} />
          )}
        </div>
        <p className="hb-field__hint">Goes to <code>{M.navRoute(item) || '—'}</code></p>
      </div>

      <div className="hb-grid">
        <Segment label="Visibility (all devices)" value={item.status} disabled={disabled} onChange={(v) => onChange({ status: v })}
          options={[['ACTIVE', 'Shown'], ['DISABLED', 'Hidden']]} />
        <div className="hb-field">
          <label htmlFor={menuId}>Dropdown</label>
          <select id={menuId} className="hb-input" value={item.megaMenuKey} disabled={disabled} onChange={(e) => onChange({ megaMenuKey: e.target.value })}>
            <option value="">None — plain link</option>
            {Object.values(menus).map((m) => <option key={m.menuKey} value={m.menuKey}>{m.name}{m.status !== 'ACTIVE' ? ' (off)' : ''}</option>)}
          </select>
          {canWrite && !item.megaMenuKey && <button type="button" className="hb-add hb-add--inline" onClick={onCreateMenu}>+ Create a new dropdown</button>}
        </div>
      </div>

      <fieldset className="hb-fieldset">
        <legend>Icon — beside the item in the mobile menu and beside its dropdown links</legend>
        <div className="hb-chips" role="radiogroup" aria-label="Icon">
          {M.NAV_ICONS.map(([name, label]) => (
            <button key={name} type="button" role="radio" aria-checked={item.icon === name} disabled={disabled}
              className={`hb-chip${item.icon === name ? ' hb-chip--on' : ''}`} onClick={() => onChange({ icon: name })}>{label}</button>
          ))}
        </div>
      </fieldset>

      {canWrite && (
        <div className="hb-editor__foot">
          <button type="button" className="hb-danger-link" onClick={onRemove}>Remove {item.label || 'this item'} from the header</button>
        </div>
      )}
    </div>
  );
}

function Dropdown({ menu, itemLabel, canWrite, errors, sharedBy, activeSlugs, archivedSlugs, entities, pickers, onChange }) {
  const disabled = !canWrite;
  const [open, setOpen] = useState('links');
  const set = (part) => onChange({ ...menu, ...part });
  const setFeatured = (part) => onChange({ ...menu, featured: { ...menu.featured, ...part } });
  const openSection = (key) => setOpen((cur) => (cur === key ? '' : key));
  const count = (re) => errors.filter((e) => re.test(e)).length;
  const kinds = menu.categoryItems.filter((r) => !r.hidden).map((r) => M.retiredKind(r.path, activeSlugs, archivedSlugs));
  const archivedCount = kinds.filter((k) => k === 'archived').length;
  const deletedCount = kinds.filter((k) => k === 'deleted').length;

  return (
    <div className="hb-tabpanel" role="tabpanel">
      <p className="hb-onemenu">
        <strong>One menu for every screen.</strong> These links are the {itemLabel || 'item'} dropdown on desktop, its submenu on tablet and mobile, and its category cards. Change them once — it changes everywhere.
      </p>
      {sharedBy.length > 0 && <p className="hb-panel__note">Also used by: {sharedBy.join(', ')} — edits change it there too.</p>}
      {archivedCount > 0 && (
        <p className="hb-field__hint hb-field__hint--warn">
          {archivedCount} link{archivedCount === 1 ? ' points' : 's point'} at a collection or category that is switched off in the catalog — {archivedCount === 1 ? 'it is' : 'they are'} hidden everywhere until switched back on.
        </p>
      )}
      {deletedCount > 0 && (
        <p className="hb-field__hint hb-field__hint--danger">
          {deletedCount} link{deletedCount === 1 ? ' points' : 's point'} at a collection or category that was deleted — {deletedCount === 1 ? 'it is' : 'they are'} not shown anywhere. Remove {deletedCount === 1 ? 'it' : 'them'} (marked “Deleted”) or choose another destination.
        </p>
      )}
      <Errors errors={errors} />
      <div className="hb-grid">
        <Segment label="Dropdown" value={menu.status} disabled={disabled} onChange={(v) => set({ status: v })} options={[['ACTIVE', 'On'], ['DISABLED', 'Off']]} />
        <TextField label="Internal name (CMS only)" value={menu.name} max={120} disabled={disabled} onChange={(v) => set({ name: v })} />
      </div>

      <Section id={`hb-sec-links-${menu.menuKey}`} title="1 · Category links" hint="desktop · tablet · mobile · cards" open={open === 'links'} onOpen={() => openSection('links')} count={count(/^Category link|^At least one category/)}>
        <RowsSection
          title="Links" rows={menu.categoryItems} max={M.LIMITS.categoryItems} disabled={disabled}
          onRows={(rows) => set({ categoryItems: rows })} addLabel="+ Add a category link" emptyLabel="No links yet."
          hint="Drag to change the order on every device. “Hidden” removes a link everywhere but keeps it here."
          makeRow={() => ({ label: '', desc: '', path: '', isViewAll: false, background: '', ref: null })}
          summary={(r) => ({ ...linkSummary(r, activeSlugs, entities, archivedSlugs), badge: r.isViewAll ? 'View all' : null })}
          renderFields={(r, p) => (
            <div className="hb-grid">
              <EntityLinkField row={r} onPatch={p} pickers={pickers} entities={entities} activeSlugs={activeSlugs} archivedSlugs={archivedSlugs} disabled={disabled} />
              <div className="hb-grid__full"><TextField label="Short description (desktop)" value={r.desc} max={M.LIMITS.itemDesc} disabled={disabled} onChange={(v) => p({ desc: v })} /></div>
              <div className="hb-grid__full">
                <Toggle checked={r.isViewAll} disabled={disabled} label="This is the “view all” link (grid icon, no card)" onChange={(v) => p({ isViewAll: v })} />
              </div>
              {menu.panel === 'shop' && !r.isViewAll && (
                <div className="hb-grid__full">
                  <Swatches small label="Card colour (shown until the collection has a photo)" value={r.background} disabled={disabled} onChange={(css) => p({ background: css })} />
                </div>
              )}
            </div>
          )}
        />
      </Section>

      <Section id={`hb-sec-promo-${menu.menuKey}`} title="2 · Promo panel" hint="desktop panel · mobile promo card" open={open === 'promo'} onOpen={() => openSection('promo')} count={count(/^Promo/)}>
        <div className="hb-grid">
          <TextField label="Heading" value={menu.featured.heading} max={M.LIMITS.heading} disabled={disabled}
            invalid={!menu.featured.heading.trim()} onChange={(v) => setFeatured({ heading: v })} />
          <TextField label="Button text" value={menu.featured.ctaLabel} max={M.LIMITS.ctaLabel} disabled={disabled} onChange={(v) => setFeatured({ ctaLabel: v })} />
        </div>
        <TextField label="Text" multiline value={menu.featured.tagline} max={M.LIMITS.tagline} disabled={disabled}
          onChange={(v) => setFeatured({ tagline: v })} hint="Shown in the desktop panel and on the mobile promo card. Press Enter for a new line." />
        <PathField label="Button link" value={menu.featured.ctaPath} disabled={disabled} activeSlugs={activeSlugs} archivedSlugs={archivedSlugs} onChange={(v) => setFeatured({ ctaPath: v })} />
        <Swatches label={`Background colour${menu.promoMediaId ? ' — the image below is shown instead' : ''}`} value={menu.featured.background} disabled={disabled} onChange={(css) => setFeatured({ background: css })} />
        <MediaPicker
          label="Image (optional)"
          hint="Replaces the colour. Text sits on top, so a darker photo reads best. Max 5MB."
          disabled={disabled}
          value={menu.promoMediaId ? { mediaId: menu.promoMediaId, url: menu.promoMediaUrl } : null}
          onChange={({ mediaId, url }) => set({ promoMediaId: mediaId || null, promoMediaUrl: url || null })}
        />
      </Section>

      <Section id={`hb-sec-right-${menu.menuKey}`} title="3 · Right side (desktop)" hint={menu.panel === 'drops' ? 'newest products' : 'category cards'} open={open === 'right'} onOpen={() => openSection('right')} count={count(/^Info card|^Fit/)}>
        <Segment label="Show" value={menu.panel} disabled={disabled} onChange={(v) => set({ panel: v })}
          options={[['shop', 'Category cards'], ['drops', 'Newest products (automatic)']]} />
        {menu.panel === 'shop' ? (
          <>
            <TextField label="Title above the cards" value={menu.shopTitle} max={60} disabled={disabled} onChange={(v) => set({ shopTitle: v })} />
            <p className="hb-panel__note">The cards are your category links (except “view all”), in the same order. Each photo comes from a product in that collection.</p>
            <Toggle checked={menu.fitsEnabled} disabled={disabled} label="Show “Shop by fit” buttons under the cards" onChange={(v) => set({ fitsEnabled: v })} />
            {menu.fitsEnabled && (
              <>
                <RowsSection
                  title="Fits" rows={menu.fits} max={M.LIMITS.fits} disabled={disabled}
                  onRows={(rows) => set({ fits: rows })} addLabel="+ Add a fit" emptyLabel="No fits."
                  makeRow={() => ({ label: '', path: '' })}
                  summary={(r) => linkSummary(r, activeSlugs, entities, archivedSlugs)}
                  renderFields={(r, p) => (
                    <div className="hb-grid">
                      <TextField label="Name" value={r.label} max={M.LIMITS.fitLabel} disabled={disabled} invalid={!r.label.trim()} onChange={(v) => p({ label: v })} />
                      <div className="hb-grid__full"><PathField value={r.path} disabled={disabled} activeSlugs={activeSlugs} archivedSlugs={archivedSlugs} placeholder="/collections/…?fit=…" onChange={(v) => p({ path: v })} /></div>
                    </div>
                  )}
                />
                <div className="hb-grid">
                  <TextField label="“View all” text" value={menu.fitsViewAllLabel} max={40} disabled={disabled} onChange={(v) => set({ fitsViewAllLabel: v })} />
                  <PathField label="“View all” link" value={menu.fitsViewAllPath || '/'} disabled={disabled} activeSlugs={activeSlugs} archivedSlugs={archivedSlugs} onChange={(v) => set({ fitsViewAllPath: v })} />
                </div>
              </>
            )}
          </>
        ) : (
          <RowsSection
            title="Info cards" rows={menu.infoCards} max={M.LIMITS.infoCards} disabled={disabled}
            onRows={(rows) => set({ infoCards: rows, hasInfo: true })} addLabel="+ Add an info card" emptyLabel="No info cards."
            hint="The four newest products appear automatically next to these. On mobile this item is a plain link."
            makeRow={() => ({ title: '', desc: '', icon: 'sparkles' })}
            summary={(r) => ({ title: (r.title || '').trim(), sub: (r.desc || '').replace(/\n/g, ' '), invalid: !(r.title || '').trim() })}
            renderFields={(r, p) => (
              <div className="hb-grid">
                <TextField label="Title" value={r.title} max={M.LIMITS.infoTitle} disabled={disabled} invalid={!r.title.trim()} onChange={(v) => p({ title: v })} />
                <div className="hb-field">
                  <label htmlFor={`hb-ic-${r._k}`}>Icon</label>
                  <select id={`hb-ic-${r._k}`} className="hb-input" value={r.icon} disabled={disabled} onChange={(e) => p({ icon: e.target.value })}>
                    {M.NAV_ICONS.map(([name, label]) => <option key={name} value={name}>{label}</option>)}
                  </select>
                </div>
                <div className="hb-grid__full"><TextField label="Text" multiline value={r.desc} max={M.LIMITS.infoDesc} disabled={disabled} onChange={(v) => p({ desc: v })} /></div>
              </div>
            )}
          />
        )}
      </Section>
    </div>
  );
}

// ---- mobile menu footer links ------------------------------------------------------------

export function MobileMenuEditor({ settings, canWrite, errors, onChange, pickers, activeSlugs, archivedSlugs, entities }) {
  const disabled = !canWrite;
  return (
    <section className="hb-panel hb-editor" aria-labelledby="hb-mobile-editor-title">
      <PathSuggestions pickers={pickers} />
      <div className="hb-panel__head">
        <h3 id="hb-mobile-editor-title" className="hb-panel__title">Editing: links &amp; tagline under the menu</h3>
      </div>
      <p className="hb-panel__note">Shown at the bottom of the tablet and mobile menu, above the logo. (On desktop these pages are in the footer.)</p>
      <Errors errors={errors} />
      <RowsSection
        title="Links" rows={settings.mobileLinks} max={M.LIMITS.settingsLinks} disabled={disabled}
        onRows={(rows) => onChange({ ...settings, mobileLinks: rows })} addLabel="+ Add a link" emptyLabel="No links — the menu goes straight to the logo."
        makeRow={() => ({ label: '', path: '', ref: null })}
        summary={(r) => linkSummary(r, activeSlugs, entities, archivedSlugs)}
        renderFields={(r, p) => (
          <div className="hb-grid">
            <EntityLinkField row={r} onPatch={p} pickers={pickers} entities={entities} activeSlugs={activeSlugs} archivedSlugs={archivedSlugs} disabled={disabled} placeholder="/help" />
          </div>
        )}
      />
      <TextField label="Tagline under the logo" value={settings.mobileTagline} max={M.LIMITS.mobileTagline} disabled={disabled}
        onChange={(v) => onChange({ ...settings, mobileTagline: v })} hint="Leave empty to show the logo alone." />
    </section>
  );
}
