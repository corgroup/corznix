// Scoped rate limiting for the auth-sensitive endpoints that genuinely
// need it (migration brief §13/§74: "do not overbuild a massive
// anti-fraud platform... but do not leave an unlimited OTP endpoint").
// `express-rate-limit` is new to this backend — added for exactly this
// (no other rate-limit package exists to conflict with).
import rateLimit from 'express-rate-limit';
import { env } from '../config/index.js';
import { securityEvent } from '../utils/securityLog.js';

// Shared handler: record the hit (no credentials) then send the limiter's
// configured message, matching express-rate-limit's default behaviour.
const limitHandler = (scope) => (req, res, _next, options) => {
  securityEvent('rate_limit_exceeded', req, { scope });
  res.status(options.statusCode).json(options.message);
};

// OTP request/verify/Google/refresh: keyed by IP. This is deliberately in
// addition to, not instead of, the per-destination cooldown
// (AuthService.requestOtp) and per-challenge attempt cap
// (AuthService.verifyOtp) — those stop abuse of one identifier; this stops
// one IP hammering many identifiers.
export const otpRequestLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitHandler('otp_request'),
  message: { error: { code: 'OTP_RATE_LIMITED', message: 'Too many requests. Please try again shortly.' } },
});

export const otpVerifyLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitHandler('otp_verify'),
  message: { error: { code: 'OTP_RATE_LIMITED', message: 'Too many attempts. Please try again shortly.' } },
});

export const authLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitHandler('auth'),
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again shortly.' } },
});

// Wave 8J-2 — inbound provider-webhook ceiling. Generous (providers can
// legitimately burst) but bounds a spoofed-endpoint flood; unverified events
// are cheap to reject and never touch business state.
export const webhookLimiter = rateLimit({
  windowMs: 60_000,
  max: Number(env.WEBHOOK_RATE_LIMIT_MAX) || 240,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitHandler('webhook'),
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests.' } },
});

// PIN-code lookup is public and each miss can cost a call to data.gov.in.
// A real customer types a handful of PINs; this bounds a script enumerating
// the whole directory through us. Typing never trips it: the form only asks
// once all six digits are in.
export const postalLookupLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitHandler('postal_lookup'),
  message: { error: { code: 'RATE_LIMITED', message: 'Too many PIN code lookups. Please enter your address manually or try again shortly.' } },
});

// Wave 8A — staff/admin login brute-force protection. Keyed by IP (the
// express-rate-limit default). Window/max are env-tunable
// (STAFF_LOGIN_RATE_LIMIT_*). Like the customer limiters this is an
// in-process store: adequate for the single-node deployment model, and
// layered on top of per-account lockout concerns handled server-side.
export const staffLoginLimiter = rateLimit({
  windowMs: Number(env.STAFF_LOGIN_RATE_LIMIT_WINDOW_MS) || 300_000,
  max: Number(env.STAFF_LOGIN_RATE_LIMIT_MAX) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitHandler('staff_login'),
  message: { error: { code: 'RATE_LIMITED', message: 'Too many login attempts. Please try again later.' } },
});
