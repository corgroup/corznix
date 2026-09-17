import { useCallback, useRef, useState } from 'react';
import { Button } from '../../../components/ui/Button.jsx';
import { InlineAlert } from '../../../components/feedback/InlineAlert.jsx';
import { LoadingState } from '../../../components/feedback/LoadingState.jsx';
import { adminApi } from '../../../api/adminApi.js';
import { LibraryBrowser } from '../../../components/media/MediaPicker.jsx';
import { useApiResource } from '../../../hooks/useApiResource.js';
import { useMutation } from '../useMutation.js';

// Product media mapping (Wave 8D). Uploads go through the backend Media API
// (MediaService -> Cloudinary) — the CMS never talks to a provider directly.
// GRADIENT rows are CSS backgrounds, not provider assets, and stay read-only.
export function MediaTab({ product, canWrite }) {
  const { status, data, error, reload } = useApiResource(() => adminApi.catalog.listProductMedia(product.id));
  const [browsing, setBrowsing] = useState(false);
  const fileRef = useRef(null);
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState(null);

  const [act, { error: actError }] = useMutation(async (fn) => fn());
  const run = useCallback(async (id, fn, msg) => {
    setBusyId(id); setNotice('');
    try { await act(fn); setNotice(msg || ''); reload(); } catch {
      // actError (rendered below) shows why; without this catch a failed
      // upload or attach also threw "Uncaught (in promise)".
    } finally { setBusyId(null); }
  }, [act, reload]);

  const media = data?.media ?? [];
  const scopes = [...new Set(media.map((m) => m.variantId || 'product'))];

  const onUpload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await run('upload', async () => {
      const asset = await adminApi.catalog.uploadMediaAsset(file);
      await adminApi.catalog.attachProductMedia(product.id, { mediaId: asset.asset.id });
    }, 'Uploaded and attached.');
  };

  if (status === 'loading') return <LoadingState label="Loading media…" />;

  return (
    <div className="tab-body">
      {browsing && (
        <LibraryBrowser
          onClose={() => setBrowsing(false)}
          onPick={(asset) => { setBrowsing(false); run('upload', () => adminApi.catalog.attachProductMedia(product.id, { mediaId: asset.id }), 'Attached from library.'); }}
        />
      )}
      <p className="tab-body__hint">
        Manage the product&rsquo;s images and video. Upload adds an asset to the media library and attaches it here.
      </p>
      {canWrite && (
        <div className="editor-actions" style={{ marginBottom: 16 }}>
          <input ref={fileRef} type="file" accept="image/*,video/*" hidden onChange={onUpload} />
          <Button busy={busyId === 'upload'} onClick={() => fileRef.current?.click()}>Upload &amp; attach</Button>
          {/* An asset already in the library should be reusable without
              uploading the same file a second time. */}
          <Button variant="soft" onClick={() => setBrowsing(true)}>Choose from library</Button>
        </div>
      )}
      {error && <InlineAlert tone="error">{error.message}</InlineAlert>}
      {actError && <InlineAlert tone="error">{actError.message}</InlineAlert>}
      {notice && <InlineAlert tone="info">{notice}</InlineAlert>}

      {media.length === 0 && <p className="text-faint">No media attached to this product.</p>}

      {scopes.map((scope) => {
        const rows = media.filter((m) => (m.variantId || 'product') === scope).sort((a, b) => a.position - b.position);
        return (
          <section key={scope} style={{ marginBottom: 24 }}>
            <h3 className="dash-section__title">{scope === 'product' ? 'Product-level' : `Variant ${scope.slice(0, 8)}`}</h3>
            <div className="media-grid">
              {rows.map((m, i) => (
                <figure key={m.id} className="media-grid__item">
                  {m.mediaType === 'GRADIENT'
                    ? <div style={{ height: 160, background: m.url }} />
                    : m.mediaType === 'VIDEO'
                      ? <video src={m.url} muted style={{ width: '100%', height: 160, objectFit: 'cover' }} />
                      : <img src={m.url} alt={m.altText || ''} loading="lazy" />}
                  <figcaption>
                    #{m.position} · {m.mediaType}{m.isPrimary ? ' · ★ primary' : ''}
                    {m.asset ? <span className="text-faint"> — {m.asset.providerKey}</span> : null}
                  </figcaption>
                  {canWrite && (
                    <div className="inline-editor__actions" style={{ flexWrap: 'wrap', gap: 4 }}>
                      <AltEditor
                        value={m.altText || ''}
                        busy={busyId === m.id}
                        onSave={(alt) => run(m.id, () => adminApi.catalog.updateProductMedia(product.id, m.id, { altText: alt || null }), 'Alt text saved.')}
                      />
                      {!m.isPrimary && (
                        <button type="button" className="linkish" disabled={busyId === m.id}
                          onClick={() => run(m.id, () => adminApi.catalog.setProductMediaPrimary(product.id, m.id), 'Primary set.')}>Make primary</button>
                      )}
                      <button type="button" className="linkish" disabled={i === 0 || busyId === m.id}
                        onClick={() => run(m.id, () => adminApi.catalog.reorderProductMedia(product.id, { variantId: scope === 'product' ? null : scope, orderedMappingIds: move(rows.map((r) => r.id), i, i - 1) }), '')}>↑</button>
                      <button type="button" className="linkish" disabled={i === rows.length - 1 || busyId === m.id}
                        onClick={() => run(m.id, () => adminApi.catalog.reorderProductMedia(product.id, { variantId: scope === 'product' ? null : scope, orderedMappingIds: move(rows.map((r) => r.id), i, i + 1) }), '')}>↓</button>
                      {m.asset && (
                        <button type="button" className="linkish" disabled={busyId === m.id}
                          onClick={() => run(m.id, () => adminApi.catalog.detachProductMedia(product.id, m.id), 'Detached (asset kept).')}>Detach</button>
                      )}
                    </div>
                  )}
                </figure>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function move(arr, from, to) {
  const next = [...arr];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function AltEditor({ value, onSave, busy }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value);
  if (!open) return <button type="button" className="linkish" onClick={() => { setText(value); setOpen(true); }}>Alt text</button>;
  return (
    <span className="inline-editor inline-editor--row">
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Describe the image" />
      <button type="button" className="linkish" disabled={busy} onClick={() => { onSave(text); setOpen(false); }}>Save</button>
      <button type="button" className="linkish" onClick={() => setOpen(false)}>Cancel</button>
    </span>
  );
}

export default MediaTab;
