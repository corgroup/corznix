// Stricter origin check for the privileged /api/v1/admin/* surface. The
// global browserOriginGuard already vets state-changing cookie requests
// against the full storefront allow-list; this narrows admin writes to the
// CMS origin(s) specifically and also covers the initial login POST (which
// has no session cookie yet). Requests with no Origin header (CLI,
// server-to-server, verification scripts) are outside a browser's CSRF
// model and pass through. Never wildcarded (Wave 8A brief §29).
import { cmsAllowedOrigins } from '../config/index.js';
import { AppError } from '../utils/errors.js';

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function cmsOriginGuard(req, _res, next) {
  if (!STATE_CHANGING.has(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  if (cmsAllowedOrigins.includes(origin)) return next();
  return next(new AppError('ORIGIN_FORBIDDEN', 'This request origin is not allowed for the admin API.', 403));
}

export default cmsOriginGuard;
