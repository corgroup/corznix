// Media Provider Contract — the ONLY interface `services/mediaService.js`
// is allowed to call. See docs/MEDIA_ABSTRACTION.md for the full
// architecture decision record. Every provider adapter (currently just
// `../providers/cloudinary/cloudinaryProvider.js`) must implement exactly
// this shape and return the normalized model below — never a raw
// provider-SDK response.
//
// Only the operations the project actually uses today are defined
// (migration brief: "do not create speculative enterprise media APIs").
// `remove` is included because `cloudinaryIntegration.destroy()` already
// existed in the pre-abstraction code (unused by any route yet, but a real
// capability) — kept so it isn't lost in the refactor.

/**
 * @typedef {Object} NormalizedMedia
 * @property {string} url             Delivery URL.
 * @property {string|null} altText
 * @property {number|null} width
 * @property {number|null} height
 * @property {string|null} mimeType   e.g. "image/jpeg".
 * @property {string|null} format     e.g. "jpg".
 * @property {number|null} size       Bytes.
 * @property {"image"|"video"|"raw"} mediaType
 * @property {Object} metadata        Provider-specific bag — the ONLY place
 *   a provider-specific identifier (e.g. Cloudinary's `public_id`) may
 *   live. Callers may persist `metadata.providerId` for later `remove()`
 *   calls, but must never branch application logic on its shape.
 * @property {string} metadata.provider    e.g. "cloudinary".
 * @property {string} metadata.providerId  The id the provider needs to
 *   remove/manage this asset later (Cloudinary's `public_id`).
 */

/**
 * @typedef {Object} MediaProvider
 * @property {boolean} isConfigured  True once the provider has everything
 *   it needs (credentials, etc.) to actually perform uploads.
 * @property {(buffer: Buffer, opts: { folder?: string, resourceType?: "auto"|"image"|"video"|"raw" }) => Promise<NormalizedMedia>} upload
 * @property {(providerId: string) => Promise<void>} remove
 */

export {};
