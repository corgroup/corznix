import { useMutation } from '../../features/catalog/useMutation.js';
import { adminApi } from '../../api/adminApi.js';

const STOREFRONT = import.meta.env.VITE_STOREFRONT_URL || 'http://localhost:5173';

// Mints a short-lived, scope-limited preview token and opens the storefront
// at `path` with `?preview=<token>` in a new tab. The token lets the public
// content endpoints serve the DRAFT for that scope only; it expires on its
// own and is server-revocable.
export default function PreviewButton({ scope, path = '/', asOf = null, label = 'Preview draft' }) {
  const [go, { busy, error }] = useMutation(async () => {
    const { token } = await adminApi.content.createPreviewToken({ scope, asOf: asOf || undefined, ttlSeconds: 900 });
    const sep = path.includes('?') ? '&' : '?';
    window.open(`${STOREFRONT}${path}${sep}preview=${encodeURIComponent(token)}`, '_blank', 'noopener,noreferrer');
  });
  return (
    <>
      <button type="button" className="linkish" disabled={busy} onClick={() => go()}>
        {busy ? 'Opening…' : label}
      </button>
      {error && <span className="text-faint" style={{ marginLeft: 6 }}>{error.message}</span>}
    </>
  );
}
