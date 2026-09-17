import { useRef, useState } from 'react';
import { PageShell } from '../layout/PageShell.jsx';
import { Button } from '../components/ui/Button.jsx';
import { InlineAlert } from '../components/feedback/InlineAlert.jsx';
import { LoadingState } from '../components/feedback/LoadingState.jsx';
import { ErrorState } from '../components/feedback/ErrorState.jsx';
import { adminApi } from '../api/adminApi.js';
import { useApiResource } from '../hooks/useApiResource.js';
import { useMutation } from '../features/catalog/useMutation.js';
import { useAuth } from '../auth/useAuth.js';

// Provider-neutral media asset registry (Cloudinary-backed today). Uploads
// go through the backend Media API. An asset still mapped to a product or a
// site-media slot cannot be deleted.
export function MediaLibraryPage() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('catalog.write');
  const { status, data, error, reload } = useApiResource(() => adminApi.catalog.listMedia({ limit: 96 }));
  const fileRef = useRef(null);
  const [notice, setNotice] = useState('');
  const [upload, { busy, error: upErr }] = useMutation((file) => adminApi.catalog.uploadMediaAsset(file));
  const [del, { error: delErr }] = useMutation((id) => adminApi.catalog.deleteMediaAsset(id));

  const assets = data?.assets ?? [];

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await upload(file);
    setNotice('Uploaded.');
    reload();
  };

  return (
    <PageShell
      title="Media Library"
      description="Every provider-hosted image and video. Provider ownership is recorded permanently — a future storage migration never rewrites it."
      actions={canWrite ? (
        <>
          <input ref={fileRef} type="file" accept="image/*,video/*" hidden onChange={onFile} />
          <Button busy={busy} onClick={() => fileRef.current?.click()}>Upload asset</Button>
        </>
      ) : null}
    >
      {upErr && <InlineAlert tone="error">{upErr.message}</InlineAlert>}
      {delErr && <InlineAlert tone="error">{delErr.message}</InlineAlert>}
      {notice && <InlineAlert tone="info">{notice}</InlineAlert>}

      {status === 'loading' && <LoadingState label="Loading media…" />}
      {status === 'error' && <ErrorState message={error?.message} onRetry={reload} />}
      {status === 'ready' && (
        assets.length === 0
          ? <p className="text-faint">No media assets yet.</p>
          : (
            <div className="media-grid">
              {assets.map((a) => (
                <figure key={a.id} className="media-grid__item">
                  {a.resourceType === 'video'
                    ? <video src={a.url} muted style={{ width: '100%', height: 160, objectFit: 'cover' }} />
                    : <img src={a.url} alt={a.altText || ''} loading="lazy" />}
                  <figcaption>
                    {a.format || a.resourceType} · {a.width || '?'}×{a.height || '?'} · used {a.usageCount}×
                    <span className="text-faint"> — {a.providerKey}</span>
                  </figcaption>
                  {canWrite && a.usageCount === 0 && (
                    <button type="button" className="linkish" onClick={async () => { if (confirm('Delete this unused asset?')) { await del(a.id); reload(); } }}>Delete</button>
                  )}
                </figure>
              ))}
            </div>
          )
      )}
      {data && data.total > assets.length && (
        <p className="page-shell__description">Showing {assets.length} of {data.total} assets.</p>
      )}
    </PageShell>
  );
}

export default MediaLibraryPage;
