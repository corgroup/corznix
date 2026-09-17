import { createHmac, timingSafeEqual } from 'node:crypto';
import { activateDbProviderConfig } from './providerConfigService.js';
import { registerWebhookVerifier, registerWebhookParser } from './webhookInboxService.js';
import { startOutboxWorker } from './outboxWorker.js';
import { startProviderHealthWorker } from './providerHealthWorker.js';
import { env } from '../../config/index.js';

// Wave 8I — one entry point wired from server.js. Additive: it swaps the
// provider-config source to the DB-backed one (falling back to in-code
// defaults for untouched rows) and starts the outbox drain loop. It does NOT
// re-route any existing provider webhook — the unified inbox is exposed as a
// NEW ingress and domains opt in by registering an applier.

/** Constant-time HMAC-SHA256 hex/base64 comparison used by provider verifiers. */
export function hmacVerifier(secretEnvKey, { encoding = 'hex', header = 'x-webhook-signature', prefix = '' } = {}) {
  return (rawBody, headers) => {
    const secret = String(env[secretEnvKey] ?? process.env[secretEnvKey] ?? '').trim();
    if (!secret) return false;
    const provided = String(headers?.[header] ?? headers?.[header.toLowerCase()] ?? '');
    if (!provided) return false;
    const expected = createHmac('sha256', secret).update(prefix + rawBody).digest(encoding);
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  };
}

let started = false;
let stopWorker = () => {};

export function startPlatformOperations({ intervalMs } = {}) {
  if (started) return stopWorker;
  started = true;

  activateDbProviderConfig();

  // Real (non-mock) verifier + parser primitives for the webhook-capable
  // providers. The live payment webhook keeps its own domain route; these are
  // here for the unified inbox ingress and for domains that adopt it.
  registerWebhookVerifier('payments', 'CASHFREE', (rawBody, headers) => {
    const secret = String(env.CASHFREE_CLIENT_SECRET ?? '').trim();
    if (!secret) return false;
    const ts = String(headers['x-webhook-timestamp'] ?? headers['x-webhook-timestamp'.toLowerCase()] ?? '');
    const sig = String(headers['x-webhook-signature'] ?? '');
    if (!ts || !sig) return false;
    const expected = createHmac('sha256', secret).update(ts + rawBody).digest('base64');
    const a = Buffer.from(sig); const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  });
  registerWebhookParser('payments', 'CASHFREE', (p) => ({
    providerEventId: p?.data?.payment?.cf_payment_id ? String(p.data.payment.cf_payment_id) : (p?.event_time ?? null),
    normalizedEventType: p?.type ?? p?.data?.payment?.payment_status ?? 'PAYMENT_EVENT',
    resourceType: 'payment', resourceId: p?.data?.order?.order_id ?? null,
    safeSummary: { type: p?.type ?? null, paymentStatus: p?.data?.payment?.payment_status ?? null },
  }));

  const stopOutbox = startOutboxWorker(intervalMs ? { intervalMs } : {});
  const stopHealth = startProviderHealthWorker();
  stopWorker = () => { stopOutbox(); stopHealth(); };
  return stopWorker;
}
