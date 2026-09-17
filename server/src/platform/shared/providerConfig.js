// Provider operational configuration loader (Provider Platform Migration,
// blueprint §21-24).
//
// This layer answers "is this provider enabled, at what priority, with what
// non-secret routing config, at what config version". It NEVER holds secrets
// (API keys, tokens, webhook signing secrets) — those stay in env / a secret
// manager and are read only inside the adapter (blueprint §22).
//
// Today the only source is `staticConfigSource` (in-code defaults). The
// `provider_configurations` MySQL table (blueprint §23) plugs in later as an
// alternate source via `setProviderConfigSource` — no caller changes when it
// does. `config_version` is surfaced now so runtime records (a booking, a
// notification delivery) can persist which config they ran under.

const compositeKey = (capability, providerKey) => `${capability}:${providerKey}`;

/**
 * @typedef {Object} ProviderConfig
 * @property {string} capability
 * @property {string} providerKey
 * @property {boolean} enabled
 * @property {number} priority     lower = preferred
 * @property {Record<string, unknown>} config   non-secret routing/config bag
 * @property {number} version      bumped on every change; 0 = code default
 * @property {string} source       'DEFAULT' | 'DATABASE' | ...
 */

// In-code defaults. Everything currently ships enabled at an equal priority;
// real ordering/toggles arrive with the CMS control plane (Phase 8).
const DEFAULTS = Object.freeze({
  'media:cloudinary': { enabled: true, priority: 100 },
  'logistics:MOCK': { enabled: true, priority: 900 },
  'logistics:DELHIVERY': { enabled: true, priority: 100 },
  'logistics:BLUE_DART': { enabled: true, priority: 200 },
  'logistics:DTDC': { enabled: true, priority: 300 },
  'payments:CASHFREE': { enabled: true, priority: 100 },
  'payments:MOCK': { enabled: true, priority: 900 },
  'auth-identity:google': { enabled: true, priority: 100 },
  'auth-otp-delivery:infyntra-whatsapp': { enabled: true, priority: 100 },
  'auth-otp-delivery:smtp-email': { enabled: true, priority: 100 },
  'social:INSTAGRAM': { enabled: true, priority: 100 },
});

/** @returns {ProviderConfig} */
function normalize(capability, providerKey, raw) {
  return {
    capability,
    providerKey,
    enabled: raw?.enabled ?? false,
    priority: Number.isFinite(raw?.priority) ? raw.priority : 1000,
    config: raw?.config ?? {},
    version: Number.isFinite(raw?.version) ? raw.version : 0,
    source: raw?.source ?? 'DEFAULT',
  };
}

/** The default source: in-code `DEFAULTS`, `{enabled:false}` for anything unknown. */
export const staticConfigSource = {
  async get(capability, providerKey) {
    const raw = DEFAULTS[compositeKey(capability, providerKey)];
    return normalize(capability, providerKey, raw ? { ...raw, source: 'DEFAULT' } : { enabled: false });
  },
  async list(capability) {
    return Object.entries(DEFAULTS)
      .filter(([entryKey]) => !capability || entryKey.startsWith(`${capability}:`))
      .map(([entryKey, raw]) => {
        const cap = entryKey.slice(0, entryKey.indexOf(':'));
        return normalize(cap, entryKey.slice(cap.length + 1), { ...raw, source: 'DEFAULT' });
      });
  },
};

let activeSource = staticConfigSource;

/** Swap the backing source (e.g. a DB-backed `provider_configurations` reader, or a test double). */
export function setProviderConfigSource(source) {
  activeSource = source || staticConfigSource;
}

/** @returns {Promise<ProviderConfig>} */
export function getProviderConfig(capability, providerKey) {
  return activeSource.get(capability, providerKey);
}

/** Enabled providers for a capability, ordered by ascending priority. */
export async function getEnabledProviders(capability) {
  const all = await activeSource.list(capability);
  return all.filter((entry) => entry.enabled).sort((a, b) => a.priority - b.priority || a.providerKey.localeCompare(b.providerKey));
}

export async function isProviderEnabled(capability, providerKey) {
  return (await getProviderConfig(capability, providerKey)).enabled;
}
