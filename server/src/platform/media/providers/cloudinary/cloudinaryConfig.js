// MOVED from server/src/integrations/cloudinary/index.js (Wave 3.5 — see
// docs/MEDIA_ABSTRACTION.md). Configuration/credential handling only —
// kept separate from cloudinaryProvider.js's upload/remove logic so the
// "is this provider even configured" question doesn't require importing
// the SDK's operational calls.
import { v2 as cloudinary } from 'cloudinary';
import { env } from '../../../../config/index.js';

export const isCloudinaryConfigured = Boolean(
  env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET
);

if (isCloudinaryConfigured) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
} else {
  console.warn(
    '[media/cloudinary] Not configured — set CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET in server/.env. ' +
      'Media upload endpoints will respond 503 until then.'
  );
}

export { cloudinary };
