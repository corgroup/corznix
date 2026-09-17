import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../utils/errors.js';
import { env, storefrontBaseUrl } from '../../config/index.js';
import { consentService } from './service.js';
import { newsletterService } from '../newsletter/service.js';

/**
 * One-click unsubscribe for marketing email.
 *
 * Every marketing email carries a link that stops marketing to that address
 * without a login. The link names the address, so it must be unforgeable —
 * otherwise anyone could unsubscribe anyone. It is an HMAC over the channel
 * and the normalised contact, keyed from JWT_SECRET (required in production)
 * with its own domain label so it can never be confused with a session token.
 *
 * It does not expire: an unsubscribe link in a months-old email must still
 * work, and all it can ever do is withdraw permission.
 */
const DOMAIN = 'corcotton:unsubscribe:v1';

const key = () => {
  if (!env.JWT_SECRET) throw new AppError('UNSUBSCRIBE_NOT_CONFIGURED', 'Unsubscribe links are not configured.', 500);
  return createHmac('sha256', env.JWT_SECRET).update(DOMAIN).digest();
};

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function unsubscribeToken(channel, contactKey) {
  const payload = b64url(`${channel}:${String(contactKey).trim().toLowerCase()}`);
  const sig = b64url(createHmac('sha256', key()).update(payload).digest());
  return `${payload}.${sig}`;
}

export function readUnsubscribeToken(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const expected = createHmac('sha256', key()).update(payload).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const decoded = Buffer.from(payload, 'base64url').toString('utf8');
  const at = decoded.indexOf(':');
  const channel = decoded.slice(0, at);
  const contactKey = decoded.slice(at + 1);
  if (!['EMAIL', 'WHATSAPP'].includes(channel) || !contactKey) return null;
  return { channel, contactKey };
}

/** The storefront page the footer link opens. */
export const unsubscribeUrl = (channel, contactKey) =>
  `${storefrontBaseUrl}/unsubscribe?t=${encodeURIComponent(unsubscribeToken(channel, contactKey))}`;

/**
 * Withdraw every promotional permission the address holds on that channel:
 * MARKETING and NEWSLETTER. Idempotent — a second click records nothing new
 * beyond the ledger entry and still answers "unsubscribed".
 */
export async function unsubscribeWithToken(token) {
  const target = readUnsubscribeToken(token);
  if (!target) throw new AppError('UNSUBSCRIBE_LINK_INVALID', 'This unsubscribe link is not valid.', 400);
  const { channel, contactKey } = target;
  for (const purpose of ['MARKETING', 'NEWSLETTER']) {
    // eslint-disable-next-line no-await-in-loop
    await consentService.record({ contactKey, channel, purpose, action: 'REVOKED', source: 'UNSUBSCRIBE_LINK' });
  }
  if (channel === 'EMAIL') {
    try {
      await newsletterService.unsubscribe({ email: contactKey, source: 'UNSUBSCRIBE_LINK' });
    } catch (error) {
      // Not being on the newsletter list is the one expected outcome here;
      // anything else is a real failure and propagates.
      if (error.code !== 'NEWSLETTER_NOT_FOUND') throw error;
    }
  }
  return { channel, unsubscribed: true };
}
