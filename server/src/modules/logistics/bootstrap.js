import { timingSafeEqual } from 'node:crypto';
import { env } from '../../config/index.js';
import { registerWebhookVerifier, registerWebhookParser, registerWebhookApplier } from '../platform/webhookInboxService.js';
import { parseDelhiveryScanPush } from './delhiveryScanPush.js';
import { parseDelhiveryEpod, parseDelhiveryQcImage, parseDelhiverySorterImage } from './delhiveryDocumentPush.js';
import { logisticsWebhookApplier } from './applier.js';
import { carrierDocumentApplier } from './documentApplier.js';

// WP-01 — wires the `logistics` capability into the unified provider webhook
// inbox (platform/webhookInboxService.js). Ingress is already generic and
// already existed: `POST /api/v1/platform/webhooks/logistics/:providerKey`
// (platform/routes.js). Before this module ran, that route accepted a
// Delhivery Scan Push, recorded it, and did nothing else — no verifier, no
// parser, no applier (08c/08d SCAN_PUSH = NOT_IMPLEMENTED).
//
// A constant-time shared-secret header check, not an HMAC: the supplied
// Delhivery material does not standardize a signature scheme for Scan Push
// ("client supplies an authorization header key/value pair", format
// unspecified — 08d §K.1). Only the DELHIVERY providerKey is verified;
// logistics/MOCK is deliberately left unverified so a dev/staging replay
// (verify-logistics-webhooks.js) needs no secret to exercise the same
// parser + applier path a real Delhivery call would use.
function delhiveryWebhookVerifier(rawBody, headers) {
  const secret = String(env.DELHIVERY_WEBHOOK_TOKEN ?? '').trim();
  if (!secret) return false; // fail-closed: unconfigured => reject, never silently accept
  const headerName = String(env.DELHIVERY_WEBHOOK_TOKEN_HEADER || 'x-delhivery-webhook-token').toLowerCase();
  const provided = String(headers?.[headerName] ?? headers?.[headerName.toLowerCase()] ?? '');
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

let registered = false;

/** Idempotent — safe to call more than once (module import order, tests). */
export function registerLogisticsWebhooks() {
  if (registered) return;
  registered = true;

  // Scan Push — status webhook.
  registerWebhookVerifier('logistics', 'DELHIVERY', delhiveryWebhookVerifier);
  registerWebhookParser('logistics', 'DELHIVERY', parseDelhiveryScanPush);
  registerWebhookParser('logistics', 'MOCK', parseDelhiveryScanPush);
  registerWebhookApplier('logistics', logisticsWebhookApplier);

  // Document Push — SEPARATE endpoints (Delhivery does not combine them with
  // Scan Push). Same shared-secret auth. Slice 17: parsed, linked to the
  // shipment by AWB, and the image persisted (base64 -> private storage, URL
  // -> linked) by carrierDocumentApplier.
  for (const cap of ['logistics-epod', 'logistics-qc', 'logistics-sorter']) {
    registerWebhookVerifier(cap, 'DELHIVERY', delhiveryWebhookVerifier);
    registerWebhookApplier(cap, carrierDocumentApplier);
  }
  registerWebhookParser('logistics-epod', 'DELHIVERY', parseDelhiveryEpod);
  registerWebhookParser('logistics-qc', 'DELHIVERY', parseDelhiveryQcImage);
  registerWebhookParser('logistics-sorter', 'DELHIVERY', parseDelhiverySorterImage);
}

export function _resetLogisticsWebhookRegistration() {
  registered = false;
}
