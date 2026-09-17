// Customer session policy — the one place idle timeout and maximum lifetime
// are decided. Both the request authenticator (middleware/authenticate.js) and
// the refresh flow (auth/service.js#refreshSession) ask this module, so an
// access token and a refresh token can never disagree about whether a session
// is still valid.
//
// Ages come from MySQL (AuthSessionRepository#findWithAge computes them with
// TIMESTAMPDIFF against NOW()), never from comparing a driver-parsed DATETIME
// with the Node clock: the columns are written in UTC by MySQL, and a JS-side
// comparison is wrong by the host's UTC offset wherever that is not UTC.
import { env } from '../../config/index.js';

export const idleTimeoutSeconds = () => Number(env.CUSTOMER_SESSION_IDLE_TIMEOUT_MINUTES) * 60;
export const maxLifetimeSeconds = () => Number(env.CUSTOMER_SESSION_MAX_LIFETIME_HOURS) * 60 * 60;

// last_seen_at is written at most this often per session, so an active
// shopper's requests do not each cost a database write. Always well inside the
// idle timeout, so activity is never missed.
export const activityWriteIntervalSeconds = () => Math.max(1, Math.min(60, Math.floor(idleTimeoutSeconds() / 10)));

export const SESSION_EXPIRED_MESSAGES = {
  IDLE_TIMEOUT: 'Your session has expired due to inactivity. Please log in again.',
  MAX_LIFETIME: 'Your session has expired. Please log in again.',
};

/**
 * Why a session row (from findWithAge) is no longer valid, or null if it is.
 * `past_expiry` is the absolute deadline set at login; `age_seconds` also caps
 * rows created before this policy, whose expires_at was pushed 30 days ahead
 * on every refresh.
 */
export function sessionExpiryReason(row) {
  if (Number(row.past_expiry) === 1) return 'MAX_LIFETIME';
  if (Number(row.age_seconds) >= maxLifetimeSeconds()) return 'MAX_LIFETIME';
  if (Number(row.idle_seconds) >= idleTimeoutSeconds()) return 'IDLE_TIMEOUT';
  return null;
}

/** Seconds left before the absolute deadline — what the refresh cookie may live. */
export function remainingLifetimeSeconds(row) {
  const byDeadline = Number(row.seconds_to_expiry);
  const byAge = maxLifetimeSeconds() - Number(row.age_seconds);
  return Math.max(0, Math.min(Number.isFinite(byDeadline) ? byDeadline : byAge, byAge));
}
