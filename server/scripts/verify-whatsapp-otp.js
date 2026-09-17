// WhatsApp OTP delivery preflight — an operator tool, not part of the offline
// suite (it makes a real outbound request, like verify:delhivery and
// verify:media-integrity).
//
// It never sends a message. Delivery requires a POST with a valid template
// payload; this posts an empty body, so a correctly-configured provider
// answers with a validation error and an incorrectly-configured one answers
// with 401 before any message can exist.
//
// Why this exists: WhatsApp login was failing in production-like config and
// the only visible symptom was `PROVIDER_UNAVAILABLE` in the audit log. The
// actual cause — the provider rejecting the API key with 401 "Invalid API
// Key" — was reachable only by reading the server's console. A customer
// failing to log in should not be the thing that discovers an expired
// credential.
//
//   npm run verify:whatsapp-otp --workspace=server
import { env, isMockOtpProviderEnabled } from '../src/config/index.js';
import { buildInfyntraRequest } from '../src/modules/auth/otpProviders.js';

const results = {};
let failures = 0;

const pass = (name, detail = '') => {
  results[name] = `PASS${detail ? ` (${detail})` : ''}`;
  console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
};
const fail = (name, detail) => {
  results[name] = `FAIL: ${detail}`;
  failures += 1;
  console.error(`  FAIL  ${name} — ${detail}`);
};
const skip = (name, detail) => {
  results[name] = `SKIP (${detail})`;
  console.log(`  SKIP  ${name} — ${detail}`);
};

// ---- 1. configuration completeness --------------------------------------
const required = {
  INFYNTRA_API_BASE_URL: env.INFYNTRA_API_BASE_URL,
  INFYNTRA_API_KEY: env.INFYNTRA_API_KEY,
  INFYNTRA_PHONE_ID: env.INFYNTRA_PHONE_ID,
  // A login OTP cannot go out as free-form text: WhatsApp requires an
  // approved authentication template.
  INFYNTRA_OTP_TEMPLATE: env.INFYNTRA_OTP_TEMPLATE,
};
const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) fail('config_complete', `missing: ${missing.join(', ')}`);
else pass('config_complete', `${Object.keys(required).length} settings present`);

// ---- 2. the request this adapter would actually build --------------------
try {
  const { url } = buildInfyntraRequest({ destination: '+919999999999', otp: '000000' });
  pass('request_builds', url.replace(/\/\d+\/send_messages$/, '/<phoneId>/send_messages'));
} catch (err) {
  // PROVIDER_PHONE_FORMAT_UNSUPPORTED here means PROVIDER_PHONE_FORMAT is set
  // to something the adapter does not know, which fails every send.
  fail('request_builds', err.message);
}

// ---- 3. does the provider accept our credentials? ------------------------
if (isMockOtpProviderEnabled()) {
  skip('provider_accepts_credentials', 'OTP_PROVIDER_MODE=MOCK — nothing is sent to a provider');
} else if (missing.length) {
  skip('provider_accepts_credentials', 'configuration incomplete');
} else {
  const base = String(env.INFYNTRA_API_BASE_URL).replace(/\/+$/, '');
  const apiBase = /\/api$/i.test(base) ? base : `${base}/api`;
  const url = `${apiBase}/${String(env.INFYNTRA_PHONE_ID).replace(/\D/g, '')}/send_messages`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { apikey: env.INFYNTRA_API_KEY, 'Content-Type': 'application/json' },
      body: '{}', // deliberately unsendable
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.json().catch(() => null);
    const provErr = body?.error || body?.errors?.[0] || {};
    const detail = `${res.status} ${provErr.code ?? ''} ${String(provErr.message ?? '').slice(0, 80)}`.trim();

    if (res.status === 401 || res.status === 403) {
      fail('provider_accepts_credentials',
        `${detail} — the API key is rejected, so every WhatsApp OTP will fail. Issue a new key in the Infyntra panel and set INFYNTRA_API_KEY.`);
    } else if (res.status === 404) {
      fail('provider_accepts_credentials',
        `${detail} — the endpoint does not exist. Check INFYNTRA_API_BASE_URL and INFYNTRA_PHONE_ID.`);
    } else {
      // Anything else means authentication got far enough for the request to
      // be evaluated on its merits, which is all this can prove without
      // actually delivering a message.
      pass('provider_accepts_credentials', `${detail} — credentials accepted; the empty payload was rejected on its own merits, as intended`);
    }
  } catch (err) {
    fail('provider_accepts_credentials', `could not reach the provider: ${err.name} ${err.message}`);
  }
}

console.log(`\n${JSON.stringify(results, null, 2)}`);
console.log(`\nWHATSAPP_OTP = ${failures ? 'FAIL' : 'PASS'}`);
if (failures) process.exit(1);
