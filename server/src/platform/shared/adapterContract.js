// Adapter conformance (Provider Platform Migration, blueprint §5).
//
// JavaScript has no compile-time interface check, so every adapter is
// validated at registration time instead: it must be an object exposing the
// method set its capability requires. Each capability owns exactly one
// contract — there is no "universal" adapter (blueprint §43).

import { createProviderError, PROVIDER_ERROR_CODES } from './providerError.js';

export const CAPABILITIES = Object.freeze({
  MEDIA: 'media',
  LOGISTICS: 'logistics',
  PAYMENTS: 'payments',
  NOTIFICATIONS: 'notifications',
  AUTH_IDENTITY: 'auth-identity',
  AUTH_OTP_DELIVERY: 'auth-otp-delivery',
});

// The REQUIRED method set per capability. Optional capabilities (e.g. a
// logistics adapter that can also book/track/cancel) are not listed here —
// callers feature-detect those. Kept to what the platform actually uses today.
export const CAPABILITY_REQUIRED_METHODS = Object.freeze({
  [CAPABILITIES.MEDIA]: ['upload', 'remove'],
  [CAPABILITIES.LOGISTICS]: ['quote'],
  [CAPABILITIES.PAYMENTS]: ['createPaymentSession', 'getPaymentStatus', 'verifyWebhook', 'normalizeWebhook'],
  [CAPABILITIES.NOTIFICATIONS]: ['send'],
  [CAPABILITIES.AUTH_IDENTITY]: ['verify'],
  [CAPABILITIES.AUTH_OTP_DELIVERY]: ['send'],
});

/**
 * @param {object} adapter
 * @param {{ capability?: string, providerKey?: string, requiredMethods?: string[] }} [opts]
 * @returns {object} the same adapter, for chaining
 * @throws {ProviderError} code PROVIDER_MISCONFIGURED
 */
export function assertAdapterConformance(adapter, { capability, providerKey, requiredMethods } = {}) {
  const fail = (message) => {
    throw createProviderError({ code: PROVIDER_ERROR_CODES.PROVIDER_MISCONFIGURED, capability, providerKey, message });
  };

  if (!adapter || typeof adapter !== 'object') fail('adapter must be an object');

  const methods = requiredMethods || CAPABILITY_REQUIRED_METHODS[capability];
  if (!methods) fail(`unknown capability "${capability}" — pass requiredMethods explicitly`);

  const missing = methods.filter((name) => typeof adapter[name] !== 'function');
  if (missing.length) fail(`adapter "${providerKey || '?'}" is missing method(s): ${missing.join(', ')}`);

  return adapter;
}
