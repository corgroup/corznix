import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';

import { allowedOrigins, env } from './config/index.js';
import { requestId } from './middleware/requestId.js';
import { requestLog } from './middleware/requestLog.js';
import { notFound } from './middleware/notFound.js';
import { errorHandler } from './middleware/errorHandler.js';
import { browserOriginGuard } from './middleware/browserOriginGuard.js';
import apiV1Routes from './routes/index.js';
import { AppError } from './utils/errors.js';

// `trust proxy` from TRUST_PROXY. Accepts a hop count ("1"), a named preset
// ("loopback"), or a CIDR / comma-list. Never `true` (that lets any client
// spoof X-Forwarded-For and defeat IP rate limiting) — rejected at env
// parse time. Unset => Express default (false), correct for direct local dev.
function parseTrustProxy(value) {
  const raw = String(value).trim();
  if (raw === '' || raw.toLowerCase() === 'false') return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw.includes(',') ? raw.split(',').map((entry) => entry.trim()).filter(Boolean) : raw;
}

export function createApp() {
  const app = express();

  // On the VPS the API sits behind exactly one nginx hop, so the real
  // client IP (used by req.ip, the auth rate limiters, and audit logging)
  // is only in X-Forwarded-For. Set TRUST_PROXY=1 there (or the docker
  // bridge subnet). Without this every proxied request collapses to the
  // bridge gateway IP and one caller can rate-limit everyone.
  if (env.TRUST_PROXY !== undefined && env.TRUST_PROXY !== '') {
    app.set('trust proxy', parseTrustProxy(env.TRUST_PROXY));
  }

  // GIS rendered-button authentication uses a Google-owned popup which must
  // post its credential result back to the storefront. Preserve opener
  // isolation for normal navigation while allowing this explicit popup flow.
  app.use(helmet({ crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' } }));
  // Google's sign-in redirect posts the credential as a FORM from
  // accounts.google.com. A browser does not apply CORS to a form navigation,
  // but this middleware rejects by Origin regardless of request kind — so
  // without an exception the credential never reaches the handler and the
  // customer is bounced with a 403 they can do nothing about.
  //
  // Scoped to that one path via the request-aware delegate, not added to
  // allowedOrigins: accounts.google.com must not become a permitted origin for
  // credentialed XHR against the rest of the API. The handler still proves the
  // post is genuine with Google's double-submit token.
  //
  // The Origin arrives as Google's own, as "null" (Safari on iOS withholds it
  // after Google's redirect chain — that rejection is what stopped iPhone
  // sign-in), or not at all. The callback proves itself with a nonce signed
  // into the Google ID token (see auth/controller.js).
  const GOOGLE_FORM_CALLBACK = '/api/v1/auth/google/callback';
  const GOOGLE_FORM_ORIGINS = new Set(['https://accounts.google.com', 'null']);
  // Before CORS, so a request rejected for its origin still leaves a line.
  app.use(requestId);
  app.use(requestLog);
  app.use(
    cors((req, callback) => {
      const origin = req.headers.origin;
      if (req.path === GOOGLE_FORM_CALLBACK && (origin === undefined || GOOGLE_FORM_ORIGINS.has(origin))) {
        // A form navigation, which CORS does not govern: send no CORS headers.
        return callback(null, { origin: false });
      }
      return callback(null, {
        credentials: true,
        origin(requestOrigin, done) {
          // Allow non-browser tools (curl, server-to-server) with no Origin header.
          if (!requestOrigin || allowedOrigins.includes(requestOrigin)) {
            return done(null, true);
          }
          return done(new AppError('ORIGIN_FORBIDDEN', 'This request origin is not allowed.', 403));
        },
      });
    })
  );
  app.use(express.json({ limit: '1mb', verify(req,_res,buffer){req.rawBody=buffer.toString('utf8');} }));
  // Wave 5 — auth session/refresh tokens travel as httpOnly cookies (see
  // modules/auth/controller.js's setAuthCookies), which requires parsing
  // incoming Cookie headers.
  app.use(cookieParser());
  app.use(browserOriginGuard);

  app.use('/api/v1', apiV1Routes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

export default createApp;
