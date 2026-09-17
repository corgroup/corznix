import { env, isProduction, isMockOtpProviderEnabled } from './env.js';

const DEFAULT_DEV_ORIGINS = [
  'http://localhost:5173', // apps/corcotton
  'http://localhost:5174', // apps/corznix
  'http://localhost:5175', // apps/cms
];

// Where the storefront actually lives, for the handful of places that have to
// send a browser back to it — Google's sign-in redirect above all.
//
// STOREFRONT_BASE_URL carries a localhost default, and neither deployment sets
// it, so reading it directly sent every signed-in customer to
// http://localhost:5173. PAYMENT_RETURN_BASE_URL is set in both and is the
// same storefront; the allowed origins are the last resort. A localhost answer
// in production is a misconfiguration, not a fallback, and says so on boot.
export const storefrontBaseUrl = (() => {
  const explicit = process.env.STOREFRONT_BASE_URL;
  const origins = (env.CORS_ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
  const resolved = (explicit || env.PAYMENT_RETURN_BASE_URL || origins[0] || env.STOREFRONT_BASE_URL || '')
    .replace(/\/+$/, '');
  if (env.NODE_ENV === 'production' && /localhost|127\.0\.0\.1/.test(resolved)) {
    // eslint-disable-next-line no-console
    console.error('[config] storefrontBaseUrl resolved to', resolved, '— set STOREFRONT_BASE_URL. Redirects back to the storefront will not work.');
  }
  return resolved;
})();

export const allowedOrigins = env.CORS_ALLOWED_ORIGINS
  ? env.CORS_ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
  : DEFAULT_DEV_ORIGINS;

// Origins permitted to make credentialed calls to the privileged
// /api/v1/admin/* surface. Deliberately narrower than `allowedOrigins`
// (the storefronts have no business calling admin routes) and never
// wildcarded. Defaults to the local CMS dev origin only.
export const cmsAllowedOrigins = env.CMS_ALLOWED_ORIGINS
  ? env.CMS_ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
  : ['http://localhost:5175'];

// Phase 2 — resolve the SMTP account for a given transactional purpose.
// Fallback chain per field: SMTP_<FIELD>_<PURPOSE>  ->  SMTP_<FIELD>  ->  null.
// purpose ∈ 'otp' | 'order' | 'support'.
export function smtpAccount(purpose = 'otp') {
  const P = String(purpose).toUpperCase();
  const pick = (field) => env[`SMTP_${field}_${P}`] || env[`SMTP_${field}`] || null;
  return {
    host: pick('HOST'),
    port: Number(env.SMTP_PORT || 587),
    secure: Boolean(env.SMTP_SECURE),
    user: pick('USER'),
    password: pick('PASSWORD'),
    from: env[`SMTP_FROM_${P}`] || env.SMTP_FROM || env.EMAIL_FROM || null,
  };
}

export { env, isProduction, isMockOtpProviderEnabled };
