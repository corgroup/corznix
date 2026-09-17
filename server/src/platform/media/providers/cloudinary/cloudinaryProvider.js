// Cloudinary adapter — implements the MediaProvider contract
// (../../contracts/mediaProvider.js). ADAPTED from the pre-abstraction
// server/src/integrations/cloudinary/index.js (Wave 3 backend; see
// docs/MEDIA_ABSTRACTION.md's "Existing Cloudinary Code" section for the
// REUSED/MOVED/ADAPTED breakdown). Logic unchanged — upload/destroy calls
// are identical — only reachable through this provider now, and every
// response is normalized before it leaves this file.
import { cloudinary, isCloudinaryConfigured } from './cloudinaryConfig.js';
import { toNormalizedMedia } from './cloudinaryMapper.js';
import { createProviderError, PROVIDER_ERROR_CODES } from '../../../shared/providerError.js';

const notConfigured = () => createProviderError({
  code: PROVIDER_ERROR_CODES.PROVIDER_NOT_CONFIGURED,
  capability: 'media',
  providerKey: 'cloudinary',
  message: 'Cloudinary is not configured.',
});

// Cloudinary's plain `upload`/`upload_stream` endpoint rejects anything
// over 10MB outright (confirmed in this wave: a real 15MB video upload
// failed with exactly this error). Above that size, the SDK's chunked
// `upload_chunked_stream` must be used instead — same abstraction-facing
// `upload()` call, this is purely an internal Cloudinary transport detail.
const CLOUDINARY_SINGLE_REQUEST_LIMIT_BYTES = 10 * 1024 * 1024;
const CHUNK_SIZE_BYTES = 6 * 1024 * 1024;

export class CloudinaryProvider {
  /** Stable identity for the shared provider registry / observability. */
  get providerKey() {
    return 'cloudinary';
  }

  get isConfigured() {
    return isCloudinaryConfigured;
  }

  /**
   * @param {Buffer} buffer
   * @param {{ folder?: string, resourceType?: "auto"|"image"|"video"|"raw" }} [options]
   *   `resourceType` defaults to "auto" (Cloudinary content-sniffs image vs.
   *   video vs. raw) for normal-sized uploads. Chunked uploads (>10MB) don't
   *   support "auto" — callers uploading a large non-video file must pass
   *   `resourceType` explicitly; large uploads default to "video" since
   *   that's the only real large-file case in this codebase today.
   * @returns {Promise<import('../../contracts/mediaProvider.js').NormalizedMedia>}
   */
  upload(buffer, { folder, resourceType = 'auto' } = {}) {
    if (!this.isConfigured) {
      throw notConfigured();
    }
    const isLarge = buffer.length > CLOUDINARY_SINGLE_REQUEST_LIMIT_BYTES;

    return new Promise((resolve, reject) => {
      const onDone = (error, result) => (error ? reject(error) : resolve(toNormalizedMedia(result)));
      const stream = isLarge
        ? cloudinary.uploader.upload_chunked_stream({
          folder,
          resource_type: resourceType === 'auto' ? 'video' : resourceType,
          chunk_size: CHUNK_SIZE_BYTES,
        }, onDone)
        : cloudinary.uploader.upload_stream({ folder, resource_type: resourceType }, onDone);
      stream.end(buffer);
    });
  }

  /**
   * @param {string} providerId  Cloudinary's `public_id` (from
   *   `NormalizedMedia.metadata.providerId`) — callers never pass a raw
   *   Cloudinary field name themselves, just whatever this provider
   *   handed back from `upload()`.
   */
  async remove(providerId) {
    if (!this.isConfigured) {
      throw notConfigured();
    }
    await cloudinary.uploader.destroy(providerId);
  }
}

export default CloudinaryProvider;
