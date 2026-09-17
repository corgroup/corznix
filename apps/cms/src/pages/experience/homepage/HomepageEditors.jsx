import { useId } from 'react';
import { MediaPicker } from '../../../components/media/MediaPicker.jsx';
import { SortableList, DragHandle } from '../../../components/ui/SortableList.jsx';
import { makeRowKey } from '../../../components/ui/rowHelpers.js';
import { TextField, Toggle, Segment, Errors, EntityLinkField, StatePill } from '../header/HeaderEditors.jsx';
import * as H from './homepageModel.js';
import { InstagramSectionEditor } from './InstagramSectionEditor.jsx';

// The selected homepage section's editor. Every control writes straight into
// the draft the live preview renders, so each keystroke shows there.

const TrashIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></svg>
);

function ListEditor({ title, hint, rows, onRows, max, disabled, makeRow, renderRow, addLabel, noun, minRows = 1, emptyLabel }) {
  const patch = (k, part) => onRows(rows.map((r) => (r._k === k ? { ...r, ...part } : r)));
  return (
    <div className="hb-rows">
      <div className="hb-rows__head">
        <span className="hb-rows__title">{title}</span>
        <span className="hb-panel__hint">{rows.length}/{max} · drag to reorder</span>
      </div>
      {hint && <p className="hb-field__hint">{hint}</p>}
      {rows.length === 0 && emptyLabel && <p className="hb-rows__empty">{emptyLabel}</p>}
      <SortableList
        label={title}
        items={rows}
        getKey={(r) => r._k}
        disabled={disabled}
        onReorder={onRows}
        renderItem={(r, i, { handleProps }) => (
          <div className="hp-list-row">
            <DragHandle {...handleProps} disabled={disabled} />
            <div className="hp-list-row__fields">{renderRow(r, (part) => patch(r._k, part), i)}</div>
            <button type="button" className="hb-icon-btn hb-icon-btn--danger" disabled={disabled || rows.length <= minRows}
              aria-label={`Remove ${noun} ${i + 1}`} title={rows.length <= minRows ? `Keep at least one ${noun} — or hide the section` : undefined}
              onClick={() => onRows(rows.filter((x) => x._k !== r._k))}>
              <TrashIcon />
            </button>
          </div>
        )}
      />
      {!disabled && (
        <button type="button" className="hb-add" disabled={rows.length >= max} onClick={() => onRows([...rows, { _k: makeRowKey(), ...makeRow() }])}>
          {rows.length >= max ? `Limit of ${max} reached` : addLabel}
        </button>
      )}
    </div>
  );
}

function CollectionSelect({ config, onPatch, pickers, entities, disabled }) {
  const id = useId();
  const entity = H.collectionEntity(config, entities);
  const options = pickers.COLLECTION?.options || [];
  const value = entity ? `${entity.type}:${entity.id}` : '';
  return (
    <div className="hb-field hb-grid__full">
      <label htmlFor={id}>Products from</label>
      <select id={id} className={`hb-input${!value ? ' hb-input--invalid' : ''}`} value={value} disabled={disabled || !entities}
        onChange={(e) => {
          const hit = entities?.byId.get(e.target.value);
          if (hit) onPatch({ collectionSlug: hit.slug, collectionRef: { type: hit.type, id: hit.id } });
        }}>
        <option value="">{entities ? '— choose —' : 'Loading…'}</option>
        {entity && !entity.active && <option value={value}>{entity.name} (switched off — section hidden)</option>}
        <optgroup label="Collections">
          {options.filter((o) => o[3] === 'COLLECTION').map((o) => <option key={`c-${o[2]}`} value={`COLLECTION:${o[2]}`}>{o[4]}</option>)}
        </optgroup>
        <optgroup label="Categories">
          {options.filter((o) => o[3] === 'CATEGORY').map((o) => <option key={`k-${o[2]}`} value={`CATEGORY:${o[2]}`}>{o[4]}</option>)}
        </optgroup>
      </select>
      {entity && <p className="hb-field__hint">Follows “{entity.name}”: renamed or given a new address, the section keeps showing it.</p>}
    </div>
  );
}

function IconSelect({ value, onChange, disabled }) {
  const id = useId();
  return (
    <div className="hb-field">
      <label htmlFor={id}>Icon</label>
      <select id={id} className="hb-input" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {H.ICONS.map(([name, label]) => <option key={name} value={name}>{label}</option>)}
      </select>
    </div>
  );
}

function RangeField({ label, value, onChange, disabled, hint }) {
  const id = useId();
  return (
    <div className="hb-field">
      <div className="hb-field__label-row">
        <label htmlFor={id}>{label}</label>
        <span className="hb-counter">{value}%</span>
      </div>
      <input id={id} className="hp-range" type="range" min={0} max={90} step={5} value={value} disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))} />
      {hint && <p className="hb-field__hint">{hint}</p>}
    </div>
  );
}

export function SectionEditor({
  section, onChange, pickers, entities, activeSlugs, archivedSlugs, instagram, canWrite, errors, warnings, state, rendered, onRemove, onManageHero,
}) {
  const disabled = !canWrite;
  const info = H.TYPE_INFO[section.type] || { name: section.type };
  const c = section.config;
  const set = (part) => onChange({ ...section, config: { ...c, ...part } });
  const text = (key, label, max, extra = {}) => (
    <TextField label={label} value={c[key] ?? ''} max={max} disabled={disabled} onChange={(v) => set({ [key]: v })} {...extra} />
  );
  const overlay = Number.isInteger(c.overlay) ? c.overlay : H.DEFAULT_OVERLAY;

  return (
    <section className="hb-panel hb-editor" aria-labelledby="hp-editor-title">
      <div className="hb-panel__head">
        <h3 id="hp-editor-title" className="hb-panel__title">{info.name}</h3>
        <StatePill state={state} />
      </div>

      <Toggle checked={section.enabled} disabled={disabled} label="Show on the homepage" onChange={(v) => onChange({ ...section, enabled: v })} />
      {section.enabled && rendered === false && <p className="hb-field__hint hb-field__hint--warn">{H.hiddenReason(section)}</p>}
      <Errors errors={errors} />
      {warnings.map((w) => <p key={w} className="hb-field__hint hb-field__hint--warn">{w}</p>)}

      {H.UNSUPPORTED.has(section.type) ? (
        <p className="hb-field__hint hb-field__hint--warn">
          The website has no design for a “{info.name}” section, so it is never shown. Remove it, or leave it switched off.
        </p>
      ) : (
        <div className="hb-grid">
          {section.type === 'HERO' && (
            <div className="hb-grid__full">
              <p className="hb-field__hint">
                The slides — image or video, text, button and schedule — are managed in <strong>Hero slides</strong> below this builder. A slide is on the website as soon as it is active.
              </p>
              <button type="button" className="hb-add hb-add--inline" onClick={onManageHero}>Go to hero slides</button>
            </div>
          )}

          {section.type === 'BRAND_STRIP' && (
            <div className="hb-grid__full">
              <ListEditor
                title="Phrases" noun="phrase" max={H.LIMITS.phrases} disabled={disabled} addLabel="+ Add phrase"
                hint="Scrolls across the page. The same strip shows on every product page."
                rows={section.phrases}
                onRows={(rows) => onChange({ ...section, phrases: rows })}
                makeRow={() => ({ text: '' })}
                renderRow={(r, patch) => (
                  <TextField label="Phrase" value={r.text} max={H.LIMITS.phrase} disabled={disabled} invalid={!r.text.trim()} onChange={(v) => patch({ text: v })} />
                )}
              />
            </div>
          )}

          {(section.type === 'PRODUCT_CAROUSEL' || section.type === 'COLLECTION_GRID') && (
            <>
              {text('eyebrow', 'Small line above the heading', H.LIMITS.eyebrow)}
              {text('heading', 'Heading', H.LIMITS.heading)}
              {section.sectionKey === 'best_sellers' && <div className="hb-grid__full">{text('description', 'Line under the heading', H.LIMITS.description, { multiline: true })}</div>}
              {H.AUTOMATIC_PRODUCTS[section.sectionKey] ? (
                <p className="hb-field__hint hb-grid__full">Products: <strong>{H.AUTOMATIC_PRODUCTS[section.sectionKey]}</strong>.</p>
              ) : (
                <>
                  <CollectionSelect config={c} onPatch={set} pickers={pickers} entities={entities} disabled={disabled} />
                  <div className="hb-grid__full">
                    <Segment label="Layout" value={section.type} disabled={disabled}
                      options={[['PRODUCT_CAROUSEL', 'Sliding row'], ['COLLECTION_GRID', 'Grid']]}
                      onChange={(v) => onChange({ ...section, type: v })} />
                  </div>
                </>
              )}
            </>
          )}

          {section.type === 'CATEGORY_SECTION' && (
            <div className="hb-grid__full">
              {text('heading', 'Heading', H.LIMITS.heading, { hint: 'The cards are your collections — manage them in Catalog → Collections.' })}
            </div>
          )}

          {section.type === 'EDITORIAL_BANNER' && (
            <>
              {text('eyebrow', 'Small line above the heading', H.LIMITS.eyebrow)}
              {text('heading', 'Heading', H.LIMITS.heading)}
              <div className="hb-grid__full">{text('body', 'Text', H.LIMITS.body, { multiline: true })}</div>
              <div className="hb-grid__full">{text('ctaLabel', 'Button text', H.LIMITS.ctaLabel, { hint: 'Leave empty for no button.' })}</div>
              <div className="hb-grid__full hb-grid">
                <EntityLinkField
                  purpose="button"
                  row={{ path: c.ctaPath || '', ref: c.ctaRef || null, label: '' }}
                  onPatch={(p) => set({ ...('path' in p ? { ctaPath: p.path } : {}), ...('ref' in p ? { ctaRef: p.ref } : {}) })}
                  pickers={pickers} entities={entities} activeSlugs={activeSlugs} archivedSlugs={archivedSlugs}
                  disabled={disabled} placeholder="/pages/…"
                />
              </div>
              <div className="hb-grid__full">
                <MediaPicker
                  label="Background image or video (optional)"
                  hint="Without one the banner is solid black. Wide works best: 1920 × 900 px. JPG, PNG, WebP or MP4. Max 5MB."
                  disabled={disabled}
                  value={section.mediaId ? { mediaId: section.mediaId, url: section.mediaUrl } : null}
                  onChange={({ mediaId, url }) => onChange({
                    ...section, mediaId: mediaId || null, mediaUrl: url || null, mediaType: url ? H.guessMediaType(url) : null,
                  })}
                />
              </div>
              {section.mediaId && (
                <div className="hb-grid__full">
                  <RangeField label="Darken the background" value={overlay} disabled={disabled}
                    hint="Keeps the white text readable on a bright picture."
                    onChange={(v) => set({ overlay: v })} />
                </div>
              )}
            </>
          )}

          {section.type === 'REVIEWS' && (
            <>
              {text('eyebrow', 'Small line above the heading', H.LIMITS.eyebrow)}
              {text('heading', 'Heading', H.LIMITS.heading)}
              <p className="hb-field__hint hb-grid__full">
                Only real reviews that customers wrote and a moderator published are shown — nothing is typed here. The section stays hidden until there is at least one.
              </p>
            </>
          )}

          {section.type === 'INSTAGRAM_VIDEOS' && (
            <InstagramSectionEditor section={section} onChange={onChange} instagram={instagram} disabled={disabled} text={text} set={set} />
          )}

          {section.type === 'TRUST_STRIP' && (
            <div className="hb-grid__full">
              <ListEditor
                title="Promises" noun="promise" max={H.LIMITS.trustItems} disabled={disabled} addLabel="+ Add promise"
                hint="Only promise what is true for every order. The same strip shows on the order page."
                rows={section.items}
                onRows={(rows) => onChange({ ...section, items: rows })}
                makeRow={() => ({ icon: 'leaf', title: '', sub: '' })}
                renderRow={(r, patch) => (
                  <div className="hp-trust-row">
                    <IconSelect value={r.icon} disabled={disabled} onChange={(v) => patch({ icon: v })} />
                    <TextField label="Title" value={r.title} max={H.LIMITS.trustTitle} disabled={disabled} invalid={!r.title.trim()} onChange={(v) => patch({ title: v })} />
                    <TextField label="Line under it" value={r.sub} max={H.LIMITS.trustSub} disabled={disabled} onChange={(v) => patch({ sub: v })} />
                  </div>
                )}
              />
            </div>
          )}
        </div>
      )}

      {canWrite && (
        <div className="hb-editor__foot">
          <button type="button" className="hb-danger-link" onClick={onRemove}>Remove this section</button>
        </div>
      )}
    </section>
  );
}
