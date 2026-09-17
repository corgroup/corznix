import { useRef, useState } from 'react';
import { adminApi } from '../../api/adminApi.js';
import { useApiResource } from '../../hooks/useApiResource.js';
import { useMutation } from '../../features/catalog/useMutation.js';
import { Button } from '../ui/Button.jsx';
import { InlineAlert } from '../feedback/InlineAlert.jsx';
import './MediaPicker.css';

// One image control for the whole CMS.
//
// Before this, only two screens could upload at all, and two others asked the
// admin to paste a raw "Media asset id" into a text box — meaning: go to the
// Media Library, upload, find the id, copy it, come back, paste it. Everything
// that needs an image should use this instead, so an admin only ever deals
// with pictures, never identifiers.
//
// It does both jobs deliberately: uploading a new file and picking one already
// in the library. The Media Library stays the central place to audit and clean
// up assets; it just stops being a mandatory stop on the way to using one.
//
// Emits the media id (what every table stores) together with the resolved URL
// (what the caller needs to render a preview), so no consumer has to re-fetch
// the asset just to show what was chosen.

const ACCEPT = 'image/jpeg,image/png,image/webp,image/avif,video/mp4';
const MAX_BYTES = 5 * 1024 * 1024;
const isVideoUrl = (url) => /\/video\/upload\/|\.(mp4|webm|mov)(\?|$)/i.test(url || '');

// The attached file, described for the editor: the last path segment, decoded,
// and its extension. Cloudinary URLs carry no original name, so this is the stored one.
const fileNameOf = (url) => {
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || '') || url; } catch { return url; }
};
const fileExtOf = (url) => (fileNameOf(url).match(/\.([a-z0-9]{2,5})$/i)?.[1] || '').toUpperCase();

export function MediaPicker({
  value,               // { mediaId, url } | null
  onChange,            // ({ mediaId, url, altText }) => void
  disabled = false,
  label = 'Image',
  hint = 'Recommended: 1920 × 800 px (2.4:1 ratio). JPG, PNG, WebP. Max 5MB.',
}) {
  const [browsing, setBrowsing] = useState(false);
  const [localError, setLocalError] = useState('');
  // The URL whose picture failed to load. A library row can outlive its file
  // on the image host; saying so beats saving a picture the website cannot show.
  const [brokenUrl, setBrokenUrl] = useState(null);
  // Pixel size of the attached picture or video, read once it loads.
  const [dims, setDims] = useState(null);
  const fileRef = useRef(null);

  const [upload, { busy: uploading, error: uploadError }] = useMutation(async (file) => {
    const res = await adminApi.catalog.uploadMediaAsset(file);
    // The upload endpoint answers with the registry row it just created.
    const asset = res?.asset ?? res;
    onChange({ mediaId: asset.id, url: asset.url, altText: asset.altText ?? null });
    return asset;
  });

  const pickFile = (file) => {
    setLocalError('');
    if (!file) return;
    // Checked here as well as server-side so the admin gets the message
    // immediately instead of after a failed 5 MB round trip.
    if (file.size > MAX_BYTES) {
      setLocalError(`That file is ${(file.size / 1024 / 1024).toFixed(1)}MB. The limit is 5MB.`);
      return;
    }
    upload(file);
  };

  const error = localError || uploadError?.message;

  return (
    <div className="media-picker">
      <span className="media-picker__label">{label}</span>

      {value?.url ? (
        <div className="media-picker__selected">
          {/* A video drawn as an <img> always "fails to load"; draw each as what it is. */}
          {isVideoUrl(value.url)
            ? <video className="media-picker__thumb" src={value.url} muted preload="metadata" onError={() => setBrokenUrl(value.url)}
                onLoadedMetadata={(e) => setDims({ url: value.url, w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })} />
            : <img className="media-picker__thumb" src={value.url} alt="" onError={() => setBrokenUrl(value.url)}
                onLoad={(e) => setDims({ url: value.url, w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />}
          <div className="media-picker__selected-body">
            {/* What is attached, so an editor can tell a replacement actually took. */}
            <div className="media-picker__info">
              <p className="media-picker__file" title={value.url}>{fileNameOf(value.url)}</p>
              <p className="media-picker__meta">
                {isVideoUrl(value.url) ? 'Video' : 'Image'}
                {fileExtOf(value.url) && ` · ${fileExtOf(value.url)}`}
                {dims?.url === value.url && dims.w > 0 && ` · ${dims.w} × ${dims.h} px`}
              </p>
            </div>
            <div className="media-picker__selected-actions">
              <Button variant="secondary" size="sm" disabled={disabled || uploading} busy={uploading} onClick={() => fileRef.current?.click()}>
                Replace
              </Button>
              <Button variant="soft" size="sm" disabled={disabled || uploading} onClick={() => setBrowsing(true)}>
                Choose from library
              </Button>
              <Button variant="danger" size="sm" disabled={disabled || uploading}
                onClick={() => onChange({ mediaId: null, url: null, altText: null })}>
                Remove
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div
          className="media-picker__dropzone"
          onDragOver={(e) => { e.preventDefault(); }}
          onDrop={(e) => { e.preventDefault(); if (!disabled) pickFile(e.dataTransfer.files?.[0]); }}
        >
          <div className="media-picker__dropzone-icon" aria-hidden="true">🖼️</div>
          <p className="media-picker__dropzone-title">{uploading ? 'Uploading…' : 'Upload image'}</p>
          <p className="media-picker__dropzone-hint">{hint}</p>
          <div className="media-picker__dropzone-actions">
            <Button disabled={disabled || uploading} busy={uploading} onClick={() => fileRef.current?.click()}>
              Choose file
            </Button>
            <Button variant="soft" disabled={disabled || uploading} onClick={() => setBrowsing(true)}>
              Choose from library
            </Button>
          </div>
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ''; }}
      />

      {error && <InlineAlert tone="error">{error}</InlineAlert>}
      {value?.url && brokenUrl === value.url && (
        <InlineAlert tone="error">
          {isVideoUrl(value.url)
            ? 'This video no longer loads — its file is missing from the media host, so the website would show nothing here. Choose another file.'
            : 'This picture no longer loads — its file is missing from the image host, so the website would show nothing here. Choose another picture.'}
        </InlineAlert>
      )}

      {browsing && (
        <LibraryBrowser
          onClose={() => setBrowsing(false)}
          onPick={(asset) => {
            onChange({ mediaId: asset.id, url: asset.url, altText: asset.altText ?? null });
            setBrowsing(false);
          }}
        />
      )}
    </div>
  );
}

/** Grid of everything already uploaded, so an asset can be reused rather than uploaded twice. */
export function LibraryBrowser({ onPick, onClose }) {
  const { status, data, error } = useApiResource(() => adminApi.catalog.listMedia({ limit: 96 }));
  const assets = data?.assets ?? [];
  const images = assets.filter((a) => a.status === 'ACTIVE');
  // Library rows whose file is gone from the image host: shown, marked, and
  // not pickable, so a missing picture is never chosen by accident.
  const [broken, setBroken] = useState(() => new Set());
  const markBroken = (id) => setBroken((cur) => (cur.has(id) ? cur : new Set([...cur, id])));

  return (
    <div className="media-picker__modal" role="dialog" aria-modal="true" aria-label="Choose from media library">
      <div className="media-picker__modal-card">
        <header className="media-picker__modal-head">
          <h2 className="media-picker__modal-title">Media library</h2>
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </header>

        {status === 'loading' && <p className="media-picker__modal-empty">Loading…</p>}
        {status === 'error' && <InlineAlert tone="error">{error?.message}</InlineAlert>}
        {status === 'ready' && images.length === 0 && (
          <p className="media-picker__modal-empty">
            Nothing in the library yet. Close this and use “Choose file” to upload the first image.
          </p>
        )}

        <div className="media-picker__grid">
          {images.map((a) => {
            const gone = broken.has(a.id);
            return (
              <button
                key={a.id}
                type="button"
                className={`media-picker__grid-item${gone ? ' media-picker__grid-item--broken' : ''}`}
                onClick={() => { if (!gone) onPick(a); }}
                disabled={gone}
                title={gone ? 'This file no longer loads from the image host' : (a.originalFilename || a.id)}
              >
                {a.resourceType === 'video'
                  ? <video className="media-picker__grid-img" src={a.url} muted preload="metadata" onError={() => markBroken(a.id)} />
                  : <img className="media-picker__grid-img" src={a.url} alt="" loading="lazy" onError={() => markBroken(a.id)} />}
                {gone && <span className="media-picker__grid-broken">File missing</span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default MediaPicker;
