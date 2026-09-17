import { isMediaConfigured } from '../../platform/media/index.js';
import * as brandsService from '../brands/service.js';
import * as mediaService from './service.js';

export async function uploadMedia(req, res, next) {
  try {
    if (!isMediaConfigured()) {
      return res.status(503).json({
        error: {
          code: 'MEDIA_NOT_CONFIGURED',
          message: 'The configured media provider has no credentials set on the server.',
        },
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: { code: 'FILE_REQUIRED', message: 'Attach a file under the "file" form field.' },
      });
    }

    const brandSlug = req.body?.brandSlug;
    if (!brandSlug) {
      return res.status(400).json({
        error: { code: 'BRAND_SLUG_REQUIRED', message: 'Provide a "brandSlug" form field (e.g. "corcotton").' },
      });
    }

    const brand = await brandsService.getBrandBySlug(brandSlug);
    const media = await mediaService.uploadMedia(req.file.buffer, { brandId: brand.id });

    res.status(201).json({ data: media });
  } catch (err) {
    next(err);
  }
}

export function getMediaById(req, res) {
  res.status(501).json({
    error: { code: 'NOT_IMPLEMENTED', message: 'Media retrieval is not implemented yet.' },
  });
}
