// ADAPTED_SOURCE_TO_TARGET from
// corcotton-store/server/src/providers/google/index.js (Wave 5). Logic
// unchanged — this wave's security review confirmed it does real
// verification (google-auth-library's `verifyIdToken`, which checks the
// token's signature against Google's published keys, its issuer, and its
// audience against our own client id) rather than trusting the raw
// `{ email: "..." }`-shaped JSON a compromised or malicious frontend could
// otherwise send (migration brief §23's explicit prohibition).
import { OAuth2Client } from 'google-auth-library';
import { env } from '../../config/index.js';

const client = new OAuth2Client(env.GOOGLE_CLIENT_ID);

/**
 * @param {string} credential Google Identity Services ID token (JWT) from the frontend.
 * @returns {Promise<{ sub: string, email: string, firstName: string, lastName: string }>}
 */
export async function verifyGoogleCredential(credential) {
  if (!credential) {
    throw new Error('GOOGLE_AUTH_FAILED');
  }
  if (!env.GOOGLE_CLIENT_ID) {
    throw new Error('GOOGLE_AUTH_NOT_CONFIGURED');
  }

  let ticket;
  try {
    ticket = await client.verifyIdToken({
      idToken: credential,
      audience: env.GOOGLE_CLIENT_ID,
    });
  } catch (error) {
    const message = String(error?.message || '');
    const category = /audience|recipient/i.test(message)
      ? 'AUDIENCE'
      : /expired|too late/i.test(message)
        ? 'EXPIRED'
        : /fetch|network|certificate|socket/i.test(message)
          ? 'NETWORK'
          : 'INVALID';
    // Never log the credential or verifier message; either can contain
    // token claims or the configured OAuth client identifier.
    console.warn(`[google-auth] status=FAILED category=${category}`);
    throw new Error('GOOGLE_AUTH_FAILED', { cause: error });
  }

  const payload = ticket.getPayload();
  if (!payload || !payload.email || !payload.email_verified) {
    throw new Error('GOOGLE_AUTH_FAILED');
  }

  return {
    sub: payload.sub,
    email: payload.email,
    firstName: payload.given_name || '',
    lastName: payload.family_name || '',
    // Echo of the nonce the redirect sign-in handed to Google; the service
    // compares it with the one this browser was issued.
    nonce: payload.nonce || null,
  };
}
