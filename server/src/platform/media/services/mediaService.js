// The ONLY module business/domain code (modules/media, modules/catalog,
// a future CMS media feature, etc.) is allowed to call for media
// operations. Nothing outside server/src/platform/media/ may import a
// provider or the `cloudinary` package directly — see
// docs/MEDIA_ABSTRACTION.md.
//
// Phase 3 (Provider Platform Migration): each operation now runs through
// `withProviderCall` — one structured `[provider] …` log line per call, and
// any non-normalized error from the adapter leaves as a `ProviderError`
// (the shared errorHandler maps that to a safe client response).
import { resolveMediaProvider } from '../index.js';
import { withProviderCall, CAPABILITIES } from '../../shared/index.js';

/**
 * @param {Buffer} buffer
 * @param {{ folder?: string, resourceType?: "auto"|"image"|"video"|"raw" }} [options]
 * @returns {Promise<import('../contracts/mediaProvider.js').NormalizedMedia>}
 */
export async function uploadMedia(buffer, options = {}) {
  const provider = resolveMediaProvider();
  return withProviderCall(
    { capability: CAPABILITIES.MEDIA, providerKey: provider.providerKey, operation: 'upload' },
    () => provider.upload(buffer, options),
  );
}

/**
 * @param {string} providerId
 */
export async function removeMedia(providerId) {
  const provider = resolveMediaProvider();
  return withProviderCall(
    { capability: CAPABILITIES.MEDIA, providerKey: provider.providerKey, operation: 'remove' },
    () => provider.remove(providerId),
  );
}

/** True once the currently-configured provider can actually perform uploads. */
export function isMediaConfigured() {
  return resolveMediaProvider().isConfigured;
}
