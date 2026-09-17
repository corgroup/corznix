import { allowedOrigins } from '../config/index.js';
import { AppError } from '../utils/errors.js';

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Google's sign-in redirect posts the credential here from accounts.google.com
// — a cross-site POST carrying a cookie, which is exactly what this guard
// exists to stop. It is exempt because it brings its OWN proof: Google sets a
// g_csrf_token cookie on this domain and repeats the value in the form body,
// and the handler refuses anything where the two disagree. An attacker cannot
// read or forge a cookie on our domain, so they cannot produce a matching
// pair. The handler also checks the Origin itself.
//
// Deliberately one exact path. Widening this to a prefix would exempt every
// future route under it.
const CROSS_SITE_CALLBACKS = new Set(['/api/v1/auth/google/callback']);

// Cookie-authenticated browser mutations must originate from an explicitly
// allowed storefront. Requests without cookies (provider callbacks,
// server-to-server integrations, CLI health checks) are outside this guard.
export function browserOriginGuard(req, _res, next) {
  if (!STATE_CHANGING_METHODS.has(req.method) || !req.headers.cookie) return next();
  // originalUrl as well as path: this guard runs before the /api/v1 router,
  // and a future move behind that mount would silently change what req.path is.
  const pathOnly = (req.originalUrl || req.path || "").split("?")[0];
  if (CROSS_SITE_CALLBACKS.has(pathOnly) || CROSS_SITE_CALLBACKS.has(req.path)) return next();

  const origin = req.headers.origin;
  if (!origin || !allowedOrigins.includes(origin)) {
    return next(new AppError('ORIGIN_FORBIDDEN', 'This request origin is not allowed.', 403));
  }

  return next();
}

export default browserOriginGuard;
