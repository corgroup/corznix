import { useMemo, useState } from 'react';
import { MediaPicker } from '../components/media/MediaPicker.jsx';
import { useSearchParams } from 'react-router-dom';
import { PageShell } from '../layout/PageShell.jsx';
import { Button } from '../components/ui/Button.jsx';
import { FormField } from '../components/ui/FormField.jsx';
import { Select } from '../components/ui/Select.jsx';
import { InlineAlert } from '../components/feedback/InlineAlert.jsx';
import { LoadingState } from '../components/feedback/LoadingState.jsx';
import { ErrorState } from '../components/feedback/ErrorState.jsx';
import { RowsEditor, CellInput, DirtyPill } from '../components/ui/RowsEditor.jsx';
import { withRowKeys, stripRowKeys, makeRowKey, useUnsavedGuard } from '../components/ui/rowHelpers.js';
import { adminApi } from '../api/adminApi.js';
import PreviewButton from '../components/content/PreviewButton.jsx';
import { useApiResource } from '../hooks/useApiResource.js';
import { useMutation } from '../features/catalog/useMutation.js';
import { useAuth } from '../auth/useAuth.js';

const TABS = [['pages', 'Pages'], ['faq', 'FAQ']];

// Backend block enum (server/src/modules/content/pagesService.js BLOCK_TYPES).
const BLOCK_TYPES = ['HEADING', 'PARAGRAPH', 'LIST', 'IMAGE', 'CONTACT', 'DIVIDER', 'CALLOUT'];
const BLOCK_LABEL = {
  HEADING: 'Heading', PARAGRAPH: 'Paragraph', LIST: 'List', IMAGE: 'Image',
  CONTACT: 'Contact rows', DIVIDER: 'Divider', CALLOUT: 'Callout',
};
// Which `data` keys each block type owns — anything else is preserved untouched.
const BLOCK_OWNED = {
  HEADING: ['text', 'level'], PARAGRAPH: ['text'], LIST: ['items', 'ordered'],
  IMAGE: ['alt', 'caption'], CONTACT: ['rows'], DIVIDER: [], CALLOUT: ['text', 'tone'],
};

export function ContentPagesPage() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('content.write');
  const canPublish = hasPermission('content.publish');
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') || 'pages';

  return (
    <PageShell title="Pages & FAQ" description="Static content pages (Our Story, Size Guide, Contact, …) and the FAQ. Draft freely — changes go live only when you Publish that page.">
      <div className="tabs" role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k}
            className={`tabs__tab${tab === k ? ' tabs__tab--active' : ''}`}
            onClick={() => setSp((p) => { const n = new URLSearchParams(p); n.set('tab', k); return n; }, { replace: true })}>
            {label}
          </button>
        ))}
      </div>
      <div className="tabs__panel">
        {tab === 'pages' && <PagesTab canWrite={canWrite} canPublish={canPublish} />}
        {tab === 'faq' && <FaqTab canWrite={canWrite} canPublish={canPublish} />}
      </div>
    </PageShell>
  );
}

function ScopePublishBar({ doc, canPublish, onPublish, loadHistory, onRollback, onDone, previewScope, previewPath }) {
  const [publish, { busy, error }] = useMutation(onPublish);
  const { data: hist, reload } = useApiResource(loadHistory);
  const [rb] = useMutation(onRollback);
  const [open, setOpen] = useState(false);

  return (
    <div className="dash-section" style={{ marginTop: 16 }}>
      <div className="editor-actions">
        <span className={`pill pill--${doc.draftDirty ? 'warn' : 'good'}`}>
          {doc.draftDirty ? 'Unpublished changes' : 'Published'} · working v{doc.workingVersion} · live v{doc.publishedVersion ?? '—'}
        </span>
        {canPublish && <Button variant="success" busy={busy} disabled={!doc.draftDirty} onClick={async () => { await publish(doc.workingVersion); onDone(); reload(); }}>Publish</Button>}
        {previewScope && <PreviewButton scope={previewScope} path={previewPath || '/'} />}
        <button type="button" className="linkish" onClick={() => setOpen((v) => !v)}>{open ? 'Hide' : 'History'}</button>
      </div>
      {error && <InlineAlert tone="error">{error.message}</InlineAlert>}
      {open && (
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table className="data-table">
            <thead><tr><th>Version</th><th>State</th><th>By</th><th>When</th><th>Summary</th><th /></tr></thead>
            <tbody>
              {(hist?.publications ?? []).map((p) => (
                <tr key={p.id}>
                  <td>v{p.version}</td><td>{p.state}</td><td>{p.publishedBy || '—'}</td>
                  <td>{p.publishedAt ? new Date(p.publishedAt).toLocaleString() : '—'}</td>
                  <td>{p.changeSummary || '—'}</td>
                  <td>{canPublish && p.state !== 'PUBLISHED' && (
                    <button type="button" className="linkish" onClick={async () => { if (confirm(`Roll back to v${p.version}?`)) { await rb(p.id); onDone(); reload(); } }}>Roll back to this</button>
                  )}</td>
                </tr>
              ))}
              {(hist?.publications ?? []).length === 0 && <tr><td colSpan={6} className="data-table__empty">Not published yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PagesTab({ canWrite, canPublish }) {
  const { status, data, error, reload } = useApiResource(() => adminApi.content.pages());
  const [selected, setSelected] = useState(null);
  const [creating, setCreating] = useState(false);

  if (status === 'loading') return <LoadingState label="Loading pages…" />;
  if (status === 'error') return <ErrorState message={error?.message} onRetry={reload} />;

  return (
    <div className="tab-body" style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 240px) 1fr', gap: 20 }}>
      <div>
        <ul className="side-list">
          {data.pages.map((p) => (
            <li key={p.slug}>
              <button type="button" className={`side-list__item${selected === p.slug ? ' side-list__item--active' : ''}`} onClick={() => { setSelected(p.slug); setCreating(false); }}>
                {p.title}
                <span className={`pill pill--${p.draftDirty ? 'warn' : (p.publishedVersion ? 'good' : 'muted')}`} style={{ marginLeft: 6 }}>
                  {p.publishedVersion ? `v${p.publishedVersion}` : 'draft'}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {canWrite && <Button variant="soft" style={{ marginTop: 8 }} onClick={() => { setCreating(true); setSelected(null); }}>New page</Button>}
      </div>
      <div>
        {creating && <NewPageForm onClose={() => setCreating(false)} onCreated={(slug) => { setCreating(false); reload(); setSelected(slug); }} />}
        {selected && <PageEditor key={selected} slug={selected} canWrite={canWrite} canPublish={canPublish} onChanged={reload} />}
        {!creating && !selected && <p className="tab-body__hint">Select a page to edit, or create a new one.</p>}
      </div>
    </div>
  );
}

function NewPageForm({ onClose, onCreated }) {
  const [f, setF] = useState({ title: '', slug: '', pageKey: '', navLabel: '', seoTitle: '', seoDescription: '' });
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }));
  const [save, { busy, error }] = useMutation((body) => adminApi.content.createPage(body));
  return (
    <form className="editor-form" style={{ maxWidth: 560 }} onSubmit={async (e) => {
      e.preventDefault();
      const res = await save({
        title: f.title.trim(), slug: f.slug.trim(), pageKey: f.pageKey.trim(),
        navLabel: f.navLabel.trim() || null, seoTitle: f.seoTitle.trim() || null, seoDescription: f.seoDescription.trim() || null,
      });
      onCreated(res.page.slug);
    }}>
      <h3>New page</h3>
      <FormField id="np-title" label="Title" value={f.title} onChange={set('title')} required />
      <FormField id="np-slug" label="Slug (kebab-case — the URL is /pages/<slug>)" value={f.slug} onChange={set('slug')} required />
      <FormField id="np-key" label="Page key (lower_snake_case, stable identifier)" value={f.pageKey} onChange={set('pageKey')} required />
      <FormField id="np-nav" label="Nav label (optional)" value={f.navLabel} onChange={set('navLabel')} />
      <FormField id="np-seot" label="SEO title (optional)" value={f.seoTitle} onChange={set('seoTitle')} />
      <FormField id="np-seod" label="SEO description (optional)" value={f.seoDescription} onChange={set('seoDescription')} />
      {error && <InlineAlert tone="error">{error.message}</InlineAlert>}
      <div className="editor-actions">
        <Button type="submit" busy={busy}>Create</Button>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
      </div>
    </form>
  );
}

function PageEditor({ slug, canWrite, canPublish, onChanged }) {
  const { status, data, error, reload } = useApiResource(() => adminApi.content.page(slug));
  if (status === 'loading') return <LoadingState label="Loading page…" />;
  if (status === 'error') return <ErrorState message={error?.message} onRetry={reload} />;
  const { document: doc, page, blocks } = data;
  const refresh = () => { reload(); onChanged(); };

  return (
    <div>
      <PageMetaForm page={page} version={doc.workingVersion} canWrite={canWrite} onSaved={refresh} />
      <BlocksEditor key={`${slug}-${doc.workingVersion}`} slug={slug} blocks={blocks} version={doc.workingVersion} canWrite={canWrite} onSaved={refresh} />
      <ScopePublishBar
        doc={doc}
        canPublish={canPublish}
        onPublish={(v) => adminApi.content.publishPage(slug, v)}
        loadHistory={() => adminApi.content.pageHistory(slug)}
        onRollback={(id) => adminApi.content.rollbackPage(slug, id)}
        onDone={refresh}
        previewScope={`page:${slug}`}
        previewPath={slug === 'journal' ? '/blog' : `/pages/${slug}`}
      />
    </div>
  );
}

function PageMetaForm({ page, version, canWrite, onSaved }) {
  const [f, setF] = useState({
    title: page.title ?? '', navLabel: page.navLabel ?? '', seoTitle: page.seoTitle ?? '',
    seoDescription: page.seoDescription ?? '', status: page.status ?? 'ACTIVE',
  });
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }));
  const [save, { busy, error }] = useMutation((body) => adminApi.content.updatePage(page.slug, body));
  return (
    <form className="editor-form" style={{ maxWidth: 620 }} onSubmit={async (e) => {
      e.preventDefault();
      await save({ ...f, navLabel: f.navLabel || null, seoTitle: f.seoTitle || null, seoDescription: f.seoDescription || null, expectedVersion: version });
      onSaved();
    }}>
      <h3>{page.title} <span className="text-faint">/pages/{page.slug}</span></h3>
      <FormField id="pm-title" label="Title" value={f.title} onChange={set('title')} disabled={!canWrite} required />
      <FormField id="pm-nav" label="Nav label" value={f.navLabel} onChange={set('navLabel')} disabled={!canWrite} />
      <FormField id="pm-seot" label="SEO title" value={f.seoTitle} onChange={set('seoTitle')} disabled={!canWrite} />
      <FormField id="pm-seod" label="SEO description" value={f.seoDescription} onChange={set('seoDescription')} disabled={!canWrite} />
      <Select id="pm-st" label="Status" value={f.status} onChange={set('status')} disabled={!canWrite} options={[['ACTIVE', 'ACTIVE'], ['ARCHIVED', 'ARCHIVED (hidden from storefront)']]} />
      {error && <InlineAlert tone="error">{error.message}</InlineAlert>}
      {canWrite && <div className="editor-actions"><Button type="submit" busy={busy}>Save details</Button></div>}
    </form>
  );
}

// ---- TARGET 8 — page body block builder --------------------------------
const hydrateBlocks = (blocks) => withRowKeys((blocks || []).map((b) => {
  const data = b.data || {};
  const rest = {};
  for (const [k, v] of Object.entries(data)) if (!(BLOCK_OWNED[b.type] || []).includes(k)) rest[k] = v;
  return { type: b.type, mediaId: b.mediaId || '', data, _rest: rest };
}));

function serialiseBlock(b) {
  const t = b.type;
  const d = b.data || {};
  const out = { type: t, data: { ...(b._rest || {}) } };
  if (t === 'HEADING') { out.data.text = (d.text || '').trim(); out.data.level = Number(d.level) || 2; }
  else if (t === 'PARAGRAPH') { out.data.text = (d.text || '').trim(); }
  else if (t === 'LIST') {
    out.data.items = (d.items || []).map((x) => (x || '').trim()).filter(Boolean);
    if (d.ordered) out.data.ordered = true;
  } else if (t === 'IMAGE') {
    if (d.alt != null && d.alt !== '') out.data.alt = d.alt;
    if (d.caption != null && d.caption !== '') out.data.caption = d.caption;
    if (b.mediaId) out.mediaId = b.mediaId;
  } else if (t === 'CONTACT') {
    out.data.rows = (d.rows || []).map((r) => ({
      label: (r.label || '').trim(), value: (r.value || '').trim(),
      ...(r.href ? { href: r.href.trim() } : {}),
    })).filter((r) => r.label || r.value);
  } else if (t === 'CALLOUT') {
    out.data.text = (d.text || '').trim();
    out.data.tone = d.tone === 'warn' ? 'warn' : 'info';
  }
  return out;
}

function BlockCard({ block, onChange, onRemove, onMove, canWrite, isFirst, isLast }) {
  const d = block.data || {};
  const patchData = (part) => onChange({ ...block, data: { ...d, ...part } });

  return (
    <div className="builder-section">
      <div className="editor-actions" style={{ justifyContent: 'space-between' }}>
        <Select id={`bt-${block._k}`} label="Block type" value={block.type} disabled={!canWrite}
          onChange={(v) => onChange({ ...block, type: v })}
          options={BLOCK_TYPES.map((t) => [t, BLOCK_LABEL[t]])} />
        {canWrite && (
          <span className="inline-editor__actions">
            <button type="button" className="linkish" onClick={() => onMove(-1)} disabled={isFirst} aria-label="Move block up">↑</button>
            <button type="button" className="linkish" onClick={() => onMove(1)} disabled={isLast} aria-label="Move block down">↓</button>
            <button type="button" className="linkish rows-editor__remove" onClick={onRemove} aria-label="Remove block">Remove</button>
          </span>
        )}
      </div>

      {block.type === 'HEADING' && (
        <div className="editor-form__grid">
          <FormField id={`h-t-${block._k}`} label="Text" value={d.text || ''} onChange={(v) => patchData({ text: v })} disabled={!canWrite} />
          <Select id={`h-l-${block._k}`} label="Level" value={String(d.level || 2)} disabled={!canWrite}
            onChange={(v) => patchData({ level: Number(v) })} options={[['2', 'H2 — section'], ['3', 'H3 — sub-section']]} />
        </div>
      )}

      {block.type === 'PARAGRAPH' && (
        <div className="form-field">
          <label htmlFor={`p-${block._k}`}>Text</label>
          <textarea id={`p-${block._k}`} rows={4} disabled={!canWrite} value={d.text || ''} onChange={(e) => patchData({ text: e.target.value })} />
          <span className="tab-body__hint">
            Formatting: <code>**bold**</code>, <code>*italic*</code>.
            {' '}Links: <code>[label](/pages/other)</code> or <code>[mail](mailto:x@y.z)</code>.
            {' '}The same syntax works in list items.
          </span>
        </div>
      )}

      {block.type === 'LIST' && (
        <div className="form-field">
          <label className="form-field" style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={Boolean(d.ordered)} disabled={!canWrite} onChange={(e) => patchData({ ordered: e.target.checked })} />
            Numbered list
          </label>
          <RowsEditor
            rows={withRowKeys((d.items || []).map((text) => ({ text })))}
            onChange={(rows) => patchData({ items: rows.map((r) => r.text ?? '') })}
            columns={[{ key: 'text', label: 'Item', render: (row, patch, ctx) => (
              <CellInput value={row.text} onChange={(v) => patch({ text: v })} disabled={ctx.disabled} ariaLabel={`List item ${ctx.index + 1}`} />
            ) }]}
            makeRow={() => ({ text: '' })}
            addLabel="Add item" maxRows={60} disabled={!canWrite} emptyLabel="No list items."
          />
        </div>
      )}

      {block.type === 'IMAGE' && (
        <div className="editor-form__grid">
          {/* Was a free-text asset id. The block keeps storing the id; the
              editor now picks a picture instead of pasting a uuid. */}
          <MediaPicker
            label="Image"
            disabled={!canWrite}
            value={block.mediaId ? { mediaId: block.mediaId, url: block.mediaUrl || null } : null}
            onChange={({ mediaId, url }) => onChange({ ...block, mediaId, mediaUrl: url })}
          />
          <FormField id={`i-a-${block._k}`} label="Alt text" value={d.alt || ''} onChange={(v) => patchData({ alt: v })} disabled={!canWrite} />
          <FormField id={`i-c-${block._k}`} label="Caption" value={d.caption || ''} onChange={(v) => patchData({ caption: v })} disabled={!canWrite} />
        </div>
      )}

      {block.type === 'CONTACT' && (
        <RowsEditor
          rows={withRowKeys(d.rows || [])}
          onChange={(rows) => patchData({ rows: stripRowKeys(rows) })}
          columns={[
            { key: 'label', label: 'Label', render: (row, patch, ctx) => <CellInput value={row.label} onChange={(v) => patch({ label: v })} disabled={ctx.disabled} ariaLabel="Contact label" /> },
            { key: 'value', label: 'Value', render: (row, patch, ctx) => <CellInput value={row.value} onChange={(v) => patch({ value: v })} disabled={ctx.disabled} ariaLabel="Contact value" /> },
            { key: 'href', label: 'Link (optional)', render: (row, patch, ctx) => <CellInput value={row.href} onChange={(v) => patch({ href: v })} disabled={ctx.disabled} placeholder="mailto:… / tel:… / /path" ariaLabel="Contact link" /> },
          ]}
          makeRow={() => ({ label: '', value: '', href: '' })}
          addLabel="Add contact row" maxRows={30} disabled={!canWrite} emptyLabel="No contact rows."
        />
      )}

      {block.type === 'CALLOUT' && (
        <div className="form-field">
          <label htmlFor={`c-t-${block._k}`}>Text</label>
          <textarea id={`c-t-${block._k}`} rows={3} disabled={!canWrite} value={d.text || ''} onChange={(e) => patchData({ text: e.target.value })} />
          <Select id={`c-tone-${block._k}`} label="Tone" value={d.tone || 'info'} disabled={!canWrite}
            onChange={(v) => patchData({ tone: v })} options={[['info', 'Information (blue)'], ['warn', 'Warning (amber)']]} />
        </div>
      )}

      {block.type === 'DIVIDER' && <p className="tab-body__hint">A horizontal rule. No settings.</p>}
    </div>
  );
}

function BlocksEditor({ slug, blocks, version, canWrite, onSaved }) {
  const initial = useMemo(() => hydrateBlocks(blocks), [blocks]);
  const [items, setItems] = useState(initial);
  const [save, { busy, error }] = useMutation((body) => adminApi.content.setPageBlocks(slug, body, version));

  const dirty = JSON.stringify(items.map(serialiseBlock)) !== JSON.stringify(initial.map(serialiseBlock));
  useUnsavedGuard(dirty);

  const patchAt = (i, next) => setItems((xs) => xs.map((x, j) => (j === i ? next : x)));
  const removeAt = (i) => setItems((xs) => xs.filter((_, j) => j !== i));
  const moveAt = (i, d) => setItems((xs) => {
    const j = i + d; if (j < 0 || j >= xs.length) return xs;
    const n = [...xs]; [n[i], n[j]] = [n[j], n[i]]; return n;
  });
  const addBlock = (type) => {
    const data = type === 'HEADING' ? { level: 2, text: '' }
      : type === 'LIST' ? { items: [] }
        : type === 'CONTACT' ? { rows: [] } : {};
    setItems((xs) => [...xs, { _k: makeRowKey(), type, mediaId: '', data, _rest: {} }]);
  };

  return (
    <div className="editor-form" style={{ maxWidth: 820, marginTop: 12 }}>
      <label className="editor-form__label">Body blocks <span style={{ marginLeft: 8 }}><DirtyPill dirty={dirty} /></span></label>
      {items.map((b, i) => (
        <BlockCard
          key={b._k}
          block={b}
          canWrite={canWrite}
          isFirst={i === 0}
          isLast={i === items.length - 1}
          onChange={(next) => patchAt(i, next)}
          onRemove={() => removeAt(i)}
          onMove={(d) => moveAt(i, d)}
        />
      ))}
      {items.length === 0 && <p className="tab-body__hint">No blocks yet.</p>}
      {canWrite && (
        <div className="editor-actions" style={{ flexWrap: 'wrap' }}>
          <span className="editor-form__label" style={{ margin: 0 }}>Add block:</span>
          {BLOCK_TYPES.map((t) => (
            <Button key={t} variant="secondary" onClick={() => addBlock(t)}>{BLOCK_LABEL[t]}</Button>
          ))}
        </div>
      )}
      {error && <InlineAlert tone="error">{error.message}</InlineAlert>}
      {canWrite && (
        <div className="editor-actions">
          <Button busy={busy} disabled={!dirty} onClick={async () => { await save(items.map(serialiseBlock)); onSaved(); }}>Save blocks</Button>
          <Button variant="secondary" disabled={!dirty} onClick={() => setItems(hydrateBlocks(blocks))}>Discard changes</Button>
        </div>
      )}
    </div>
  );
}

// ---- TARGET 9 — FAQ table editor --------------------------------------
function FaqTab({ canWrite, canPublish }) {
  const { status, data, error, reload } = useApiResource(() => adminApi.content.faq());
  if (status === 'loading') return <LoadingState label="Loading FAQ…" />;
  if (status === 'error') return <ErrorState message={error?.message} onRetry={reload} />;
  const { document: doc, items } = data;

  return (
    <div className="tab-body">
      <p className="tab-body__hint">One flat, ordered list of questions. The category groups them on the storefront. In an answer, a blank line starts a new paragraph.</p>
      <FaqEditor key={doc.workingVersion} items={items} version={doc.workingVersion} canWrite={canWrite} onSaved={reload} />
      <ScopePublishBar
        doc={doc}
        canPublish={canPublish}
        onPublish={(v) => adminApi.content.publishFaq(v)}
        loadHistory={() => adminApi.content.faqHistory()}
        onRollback={(id) => adminApi.content.rollbackFaq(id)}
        onDone={reload}
        previewScope="faq"
        previewPath="/pages/faqs"
      />
    </div>
  );
}

function FaqEditor({ items, version, canWrite, onSaved }) {
  const hydrate = () => withRowKeys((items || []).map((it) => ({
    category: it.category || '',
    question: it.question || '',
    answer: (Array.isArray(it.answer) ? it.answer : [it.answer]).filter(Boolean).join('\n\n'),
  })));
  const [rows, setRows] = useState(hydrate);
  const [save, { busy, error }] = useMutation((body) => adminApi.content.setFaqItems(body, version));

  const categories = useMemo(
    () => [...new Set((items || []).map((it) => it.category).filter(Boolean))],
    [items],
  );
  const serialise = (rs) => rs.map((r) => ({
    category: (r.category || '').trim() || 'General',
    question: (r.question || '').trim(),
    answer: (r.answer || '').trim(),
  }));
  const dirty = JSON.stringify(serialise(rows)) !== JSON.stringify(serialise(hydrate()));
  useUnsavedGuard(dirty);

  const listId = 'faq-cat-list';
  return (
    <div className="editor-form" style={{ maxWidth: 900 }}>
      <label className="editor-form__label">Questions <span style={{ marginLeft: 8 }}><DirtyPill dirty={dirty} /></span></label>
      <datalist id={listId}>{categories.map((c) => <option key={c} value={c} />)}</datalist>
      <RowsEditor
        rows={rows}
        onChange={setRows}
        columns={[
          { key: 'category', label: 'Category', width: '160px', render: (row, patch, ctx) => (
            <CellInput value={row.category} onChange={(v) => patch({ category: v })} disabled={ctx.disabled} list={listId} placeholder="General" ariaLabel={`Category, question ${ctx.index + 1}`} />
          ) },
          { key: 'question', label: 'Question', width: '30%', render: (row, patch, ctx) => (
            <CellInput value={row.question} onChange={(v) => patch({ question: v })} disabled={ctx.disabled} ariaLabel={`Question ${ctx.index + 1}`} />
          ) },
          { key: 'answer', label: 'Answer', render: (row, patch, ctx) => (
            <textarea className="rows-editor__input" rows={2} value={row.answer ?? ''} disabled={ctx.disabled}
              aria-label={`Answer ${ctx.index + 1}`} onChange={(e) => patch({ answer: e.target.value })} />
          ) },
        ]}
        makeRow={() => ({ category: categories[0] || 'General', question: '', answer: '' })}
        addLabel="Add question" maxRows={300} disabled={!canWrite} emptyLabel="No FAQ entries yet."
      />
      {error && <InlineAlert tone="error">{error.message}</InlineAlert>}
      {canWrite && (
        <div className="editor-actions">
          <Button busy={busy} disabled={!dirty} onClick={async () => { await save(serialise(rows)); onSaved(); }}>Save FAQ draft</Button>
          <Button variant="secondary" disabled={!dirty} onClick={() => setRows(hydrate())}>Discard changes</Button>
        </div>
      )}
    </div>
  );
}

export default ContentPagesPage;
