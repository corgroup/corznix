import { logger } from '../../utils/logger.js';

// Product thumbnails for the invoice. Loaded when the PDF is rendered, not
// stored in the immutable snapshot (which keeps only the image URL).
//
// Only Cloudinary images are fetched, as a 120px JPEG via a URL transformation.
// A thumbnail is decoration: when it cannot be loaded in time the invoice is
// rendered without it, and the reason is logged. INVOICE_ITEM_IMAGES=false
// turns loading off (the verify gates do, so they make no network calls).
const log = logger('invoice-images');
const CLOUDINARY_UPLOAD = /^https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\//;
const MAX_BYTES = 2 * 1024 * 1024;

export function invoiceThumbnailUrl(url) {
  if (typeof url !== 'string' || !CLOUDINARY_UPLOAD.test(url)) return null;
  return url.replace('/image/upload/', '/image/upload/c_fill,w_120,h_120,f_jpg,q_80/');
}

/** @returns {Promise<Map<string, Buffer>>} original image URL -> JPEG/PNG bytes */
export async function loadInvoiceImages(snapshot, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 4000,
  enabled = process.env.INVOICE_ITEM_IMAGES !== 'false',
} = {}) {
  const images = new Map();
  if (!enabled || typeof fetchImpl !== 'function') return images;
  const urls = [...new Set((snapshot?.items || []).map((it) => it.imageUrl).filter(Boolean))];
  for (const url of urls) {
    const thumb = invoiceThumbnailUrl(url);
    if (!thumb) continue;
    try {
      const res = await fetchImpl(thumb, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) { log.warn('invoice_image_unavailable', { status: res.status }); continue; }
      const type = String(res.headers?.get?.('content-type') || '');
      if (!/^image\/(jpeg|png)/.test(type)) { log.warn('invoice_image_unsupported_type', { type }); continue; }
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_BYTES) { log.warn('invoice_image_bad_size', { bytes: bytes.length }); continue; }
      images.set(url, bytes);
    } catch (err) {
      log.warn('invoice_image_failed', { error: err?.name === 'TimeoutError' ? 'timeout' : err?.message || String(err) });
    }
  }
  return images;
}
