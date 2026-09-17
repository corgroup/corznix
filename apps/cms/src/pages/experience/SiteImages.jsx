import { adminApi } from '../../api/adminApi.js';
import { useApiResource } from '../../hooks/useApiResource.js';
import { useMutation } from '../../features/catalog/useMutation.js';
import { InlineAlert } from '../../components/feedback/InlineAlert.jsx';
import { LoadingState } from '../../components/feedback/LoadingState.jsx';
import { ErrorState } from '../../components/feedback/ErrorState.jsx';
import { MediaPicker } from '../../components/media/MediaPicker.jsx';
import './SiteImages.css';

// The fixed, one-per-site image slots.
//
// These have always had a working API (PUT /admin/catalog/site-media/:key) and
// never had a screen, so the only way to set the sign-in artwork or the promo
// banner was a hand-written API call. That is what this fixes.
//
// Slots are a different shape from hero banners on purpose: there is exactly
// one sign-in banner, so it is a named slot, not a list. Anything that needs
// several entries with their own copy and schedule belongs in Hero Banners.

const SLOTS = {
  promo_banner: {
    label: 'Promotional banner',
    help: 'Shown in the storefront promo slot. Wide crop works best.',
    hint: 'Recommended: 1600 × 600 px. JPG, PNG, WebP. Max 5MB.',
  },
  auth_banner: {
    label: 'Sign-in page banner',
    help: 'The artwork beside the customer login and sign-up form.',
    hint: 'Recommended: 1200 × 1600 px (portrait). JPG, PNG, WebP. Max 5MB.',
  },
  newsletter_banner: {
    label: 'Newsletter popup banner',
    help: 'The image panel in the newsletter signup popup. Falls back to the sign-in banner while this is empty.',
    hint: 'Recommended: 1200 × 1600 px (portrait). Rendered in black and white. JPG, PNG, WebP. Max 5MB.',
  },
  home_hero_1: {
    label: 'Homepage hero — fallback slide 1',
    help: 'Only used when no Hero Banners exist. Manage the real homepage hero under the Homepage tab.',
    hint: 'Legacy slot. Prefer Hero Banners.',
    legacy: true,
  },
  home_hero_2: {
    label: 'Homepage hero — fallback slide 2',
    help: 'Only used when no Hero Banners exist. Manage the real homepage hero under the Homepage tab.',
    hint: 'Legacy slot. Prefer Hero Banners.',
    legacy: true,
  },
};

export function SiteImages({ canWrite }) {
  const { status, data, error, reload } = useApiResource(() => adminApi.catalog.siteMedia());
  const [save, { busy, error: saveErr }] = useMutation(({ key, mediaId }) =>
    adminApi.catalog.setSiteMedia(key, mediaId, null));

  if (status === 'loading') return <LoadingState label="Loading site images…" />;
  if (status === 'error') return <ErrorState message={error?.message} onRetry={reload} />;

  const slots = data?.siteMedia ?? [];
  const current = slots.filter((s) => !SLOTS[s.key]?.legacy);
  const legacy = slots.filter((s) => SLOTS[s.key]?.legacy);

  const apply = async (key, mediaId) => { await save({ key, mediaId }); reload(); };

  const renderSlot = (slot) => {
    const meta = SLOTS[slot.key] || { label: slot.key, help: '', hint: undefined };
    return (
      <div className="site-image" key={slot.key}>
        <div className="site-image__meta">
          <h4 className="site-image__label">{meta.label}</h4>
          <p className="site-image__help">{meta.help}</p>
          {/* The slot key is what the storefront reads — worth showing, but as
              reference rather than something anyone has to type. */}
          <code className="site-image__key">{slot.key}</code>
        </div>
        <div className="site-image__control">
          <MediaPicker
            label=""
            hint={meta.hint}
            disabled={!canWrite || busy}
            value={slot.mediaId ? { mediaId: slot.mediaId, url: slot.url } : null}
            onChange={({ mediaId }) => apply(slot.key, mediaId)}
          />
          {/* An asset can be archived or removed at the provider after it was
              bound here; say so rather than showing a silently broken slot. */}
          {slot.assigned && slot.assetStatus && slot.assetStatus !== 'ACTIVE' && (
            <InlineAlert tone="warning">
              The bound asset is {slot.assetStatus}. Choose another image.
            </InlineAlert>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="tab-body site-images">
      <p className="tab-body__hint">
        Fixed image slots used across the storefront. Each holds exactly one image — for the
        homepage hero, which is a list of scheduled banners, use the <strong>Homepage</strong> tab.
      </p>

      {saveErr && <InlineAlert tone="error">{saveErr.message}</InlineAlert>}

      <div className="site-images__list">{current.map(renderSlot)}</div>

      {legacy.length > 0 && (
        <details className="site-images__legacy">
          <summary className="site-images__legacy-summary">
            Legacy homepage hero slots ({legacy.length})
          </summary>
          <p className="site-images__legacy-note">
            These drove the old homepage hero. They are only used while no Hero Banners exist,
            and can be left alone once you have created banners under the Homepage tab.
          </p>
          <div className="site-images__list">{legacy.map(renderSlot)}</div>
        </details>
      )}
    </div>
  );
}

export default SiteImages;
