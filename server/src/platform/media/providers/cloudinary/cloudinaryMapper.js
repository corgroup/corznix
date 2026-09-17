// Maps Cloudinary's raw SDK response shape into the provider-neutral
// `NormalizedMedia` model (see ../../contracts/mediaProvider.js). This is
// the ONLY file in the codebase allowed to read `public_id`, `secure_url`,
// `resource_type`, `bytes`, etc. by name.
/**
 * @param {import('cloudinary').UploadApiResponse} raw
 * @returns {import('../../contracts/mediaProvider.js').NormalizedMedia}
 */
export function toNormalizedMedia(raw) {
  return {
    url: raw.secure_url,
    altText: null,
    width: raw.width ?? null,
    height: raw.height ?? null,
    mimeType: raw.resource_type && raw.format ? `${raw.resource_type}/${raw.format}` : null,
    format: raw.format ?? null,
    size: raw.bytes ?? null,
    mediaType: raw.resource_type === 'video' ? 'video' : raw.resource_type === 'raw' ? 'raw' : 'image',
    metadata: {
      provider: 'cloudinary',
      providerId: raw.public_id,
    },
  };
}
