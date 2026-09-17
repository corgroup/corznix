// Wave 8I — the fixed catalogue of provider capabilities the platform
// operates. New providers are NOT added here just to prove abstraction
// (§115) — this is exactly what CORCOTTON runs today.
//
// `secretEnv` lists the env vars an adapter reads for its credentials. The
// operational plane only ever checks PRESENCE — it never reads or stores the
// values (§18/§19).

import { env } from '../../config/index.js';

export const PROVIDERS = Object.freeze([
  { capability: 'media', providerKey: 'cloudinary', label: 'Cloudinary', secretEnv: ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'], webhookCapable: false },
  { capability: 'logistics', providerKey: 'DELHIVERY', label: 'Delhivery', secretEnv: ['DELHIVERY_API_TOKEN', 'DELHIVERY_WEBHOOK_TOKEN'], webhookCapable: true },
  { capability: 'logistics', providerKey: 'MOCK', label: 'Development Mock (logistics)', secretEnv: [], webhookCapable: true },
  // Phase 2 — Delhivery Document Push webhooks. Delhivery keeps status (Scan
  // Push) and documents on SEPARATE endpoints, so each is its own capability
  // (same shared-secret auth via DELHIVERY_WEBHOOK_TOKEN).
  { capability: 'logistics-epod', providerKey: 'DELHIVERY', label: 'Delhivery POD / EPOD Push', secretEnv: ['DELHIVERY_WEBHOOK_TOKEN'], webhookCapable: true },
  { capability: 'logistics-qc', providerKey: 'DELHIVERY', label: 'Delhivery QC Image Push', secretEnv: ['DELHIVERY_WEBHOOK_TOKEN'], webhookCapable: true },
  { capability: 'logistics-sorter', providerKey: 'DELHIVERY', label: 'Delhivery Sorter Image Push', secretEnv: ['DELHIVERY_WEBHOOK_TOKEN'], webhookCapable: true },
  { capability: 'payments', providerKey: 'CASHFREE', label: 'Cashfree Payments', secretEnv: ['CASHFREE_CLIENT_ID', 'CASHFREE_CLIENT_SECRET'], webhookCapable: true },
  { capability: 'payments', providerKey: 'RAZORPAY', label: 'Razorpay Payments', secretEnv: ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'], webhookCapable: true },
  { capability: 'payments', providerKey: 'MOCK_PAYMENT', label: 'Development Mock Payment', secretEnv: [], webhookCapable: true },
  { capability: 'notifications', providerKey: 'MOCK_EMAIL', label: 'Email (mock)', secretEnv: ['SMTP_HOST', 'SMTP_FROM'], webhookCapable: true },
  { capability: 'notifications', providerKey: 'MOCK_WHATSAPP', label: 'WhatsApp (mock)', secretEnv: ['INFYNTRA_API_BASE_URL', 'INFYNTRA_API_KEY', 'INFYNTRA_PHONE_ID'], webhookCapable: true },
  // WP-06 — the real communications-engine adapters (communications/providers.js
  // codes SMTP_EMAIL / INFYNTRA_WHATSAPP). Listed here purely for CMS config/
  // health visibility (providerConfigService, providerHealthService iterate
  // this array) — the communications outbox does not route through the
  // unified webhook inbox, so `webhookCapable` is honestly false: no
  // delivery-status webhook contract exists for either transport yet.
  { capability: 'notifications', providerKey: 'SMTP_EMAIL', label: 'Email (SMTP)', secretEnv: ['SMTP_HOST', 'SMTP_FROM'], webhookCapable: false },
  { capability: 'notifications', providerKey: 'INFYNTRA_WHATSAPP', label: 'WhatsApp (Infyntra)', secretEnv: ['INFYNTRA_API_BASE_URL', 'INFYNTRA_API_KEY', 'INFYNTRA_PHONE_ID'], webhookCapable: false },
  // The homepage Instagram section's posts (modules/instagram). The access
  // token is connected in CMS -> Providers -> Instagram and stored encrypted;
  // what the environment must hold is the key that encrypts it.
  { capability: 'social', providerKey: 'INSTAGRAM', label: 'Instagram (official API)', secretEnv: ['PROVIDER_SECRET_ENCRYPTION_KEY'], webhookCapable: false },
]);

export const CAPABILITY_KEYS = ['media', 'logistics', 'payments', 'notifications', 'social'];

export function providerDescriptor(capability, providerKey) {
  return PROVIDERS.find((p) => p.capability === capability && p.providerKey === providerKey) || null;
}

/**
 * Presence-only credential check (§19/§120).
 *   NOT_CONFIGURED  — a required env var is missing
 *   CONFIGURED      — all present (validity is a HEALTH question, decided from
 *                     real attempt evidence, not from here)
 */
export function secretStatus(capability, providerKey) {
  const d = providerDescriptor(capability, providerKey);
  if (!d) return 'UNKNOWN';
  if (d.secretEnv.length === 0) return 'CONFIGURED';
  const present = d.secretEnv.filter((k) => String(env[k] ?? '').trim() !== '');
  if (present.length === 0) return 'NOT_CONFIGURED';
  if (present.length < d.secretEnv.length) return 'PARTIAL';
  return 'CONFIGURED';
}
