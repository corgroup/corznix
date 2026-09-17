// ADAPTED_SOURCE_TO_TARGET from
// corcotton-store/server/src/middleware/authenticate.js (Wave 5). Reads
// the access-token cookie (or Authorization: Bearer, for non-browser
// clients/tests), verifies its JWT signature/issuer/audience/expiry, then
// confirms the session it names is still ACTIVE server-side — a valid JWT
// alone is never sufficient, since a revoked/logged-out session must stop
// working immediately, not just at token expiry (migration brief §37/§91).
//
// SECURITY FIX (this wave's review): the source version never checked
// `customer.status` here — a SUSPENDED customer with an otherwise-valid,
// unexpired session token would sail through. Added.
import { AppError } from '../utils/errors.js';
import { env } from '../config/index.js';
import { AuthSessionRepository } from '../modules/customers/repositories.js';
import { CustomerRepository } from '../modules/customers/repositories.js';
import { verifyJwt } from '../utils/jwt.js';
import { SESSION_EXPIRED_MESSAGES, activityWriteIntervalSeconds, sessionExpiryReason } from '../modules/auth/sessionPolicy.js';

const sessionRepository = new AuthSessionRepository();
const customerRepository = new CustomerRepository();

function extractToken(req) {
  const cookieName = env.SESSION_COOKIE_NAME;
  if (req.cookies?.[cookieName]) return req.cookies[cookieName];
  const authHeader = req.headers.authorization;
  if (authHeader && /^Bearer\s+/i.test(authHeader)) {
    return authHeader.replace(/^Bearer\s+/i, '').trim();
  }
  return null;
}

async function authenticateRequest(req, res, next, { required }) {
  try {
    const rawToken = extractToken(req);
    if (!rawToken) {
      if (!required) return next();
      throw new AppError('AUTH_REQUIRED', 'Authentication required.', 401);
    }

    let payload;
    try {
      payload = verifyJwt(rawToken);
    } catch (err) {
      const code = /expired/i.test(err.message) ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID';
      throw new AppError(code, 'Your session token is no longer valid.', 401);
    }

    const session = await sessionRepository.findWithAge(payload.sid);
    if (!session || session.customer_id !== payload.sub) {
      throw new AppError('TOKEN_INVALID', 'Your session token is no longer valid.', 401);
    }
    if (session.status === 'EXPIRED') {
      throw new AppError('SESSION_EXPIRED', SESSION_EXPIRED_MESSAGES.MAX_LIFETIME, 401);
    }
    if (session.status !== 'ACTIVE') {
      throw new AppError('SESSION_REVOKED', 'Your session has been revoked.', 401);
    }
    // Idle timeout and maximum lifetime (auth/sessionPolicy.js). Checked on
    // every request, not only at refresh: a 15-minute access token must not
    // outlive a session that has already ended.
    const expiry = sessionExpiryReason(session);
    if (expiry) {
      await sessionRepository.expire(session.id);
      throw new AppError('SESSION_EXPIRED', SESSION_EXPIRED_MESSAGES[expiry], 401);
    }

    const customer = await customerRepository.findById(session.customer_id);
    if (!customer) {
      throw new AppError('AUTH_REQUIRED', 'Authentication required.', 401);
    }
    if (customer.status === 'SUSPENDED') {
      throw new AppError('ACCOUNT_SUSPENDED', 'This account is currently suspended.', 403);
    }

    // Activity keeps the session inside its idle timeout (throttled write).
    await sessionRepository.touchIfStale(session.id, activityWriteIntervalSeconds());
    // Account, order and payment responses must not be kept by the browser or
    // any proxy: after logout or expiry, Back must not replay them from cache.
    res.set('Cache-Control', 'no-store');

    req.customer = customer;
    req.session = session;
    next();
  } catch (error) {
    next(error);
  }
}

export async function authenticate(req, res, next) {
  return authenticateRequest(req, res, next, { required: true });
}

// Session bootstrap treats a genuinely absent cookie as an ordinary Guest,
// but still validates any cookie that is present. Expired, invalid, revoked,
// and suspended sessions therefore retain their normal security responses.
export async function authenticateOptional(req, res, next) {
  return authenticateRequest(req, res, next, { required: false });
}
