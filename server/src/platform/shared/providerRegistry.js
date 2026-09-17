// Central provider registry (Provider Platform Migration, blueprint §7).
//
// The ONE place a `capability + providerKey` resolves to an adapter. No
// business service should spread `if (provider === 'x')` branches — it asks
// the registry. Adapters are registered once at startup; `register` runs the
// capability conformance check so a broken adapter fails loudly at boot, not
// on the first customer request.

import { assertAdapterConformance } from './adapterContract.js';
import { createProviderError, PROVIDER_ERROR_CODES } from './providerError.js';

const key = (capability, providerKey) => `${capability}:${providerKey}`;

export function createProviderRegistry() {
  /** @type {Map<string, object>} */
  const adapters = new Map();

  return {
    /**
     * @param {string} capability
     * @param {string} providerKey
     * @param {object} adapter
     * @param {{ requiredMethods?: string[] }} [opts]
     */
    register(capability, providerKey, adapter, opts = {}) {
      if (!capability || !providerKey) {
        throw createProviderError({
          code: PROVIDER_ERROR_CODES.PROVIDER_MISCONFIGURED,
          message: 'register(capability, providerKey, adapter): capability and providerKey are required',
        });
      }
      assertAdapterConformance(adapter, { capability, providerKey, requiredMethods: opts.requiredMethods });
      adapters.set(key(capability, providerKey), adapter);
      return adapter;
    },

    /** @throws {ProviderError} code PROVIDER_NOT_CONFIGURED when nothing is registered */
    get(capability, providerKey) {
      const adapter = adapters.get(key(capability, providerKey));
      if (!adapter) {
        throw createProviderError({
          code: PROVIDER_ERROR_CODES.PROVIDER_NOT_CONFIGURED,
          capability,
          providerKey,
          message: `no adapter registered for ${key(capability, providerKey)}`,
        });
      }
      return adapter;
    },

    tryGet(capability, providerKey) {
      return adapters.get(key(capability, providerKey)) || null;
    },

    has(capability, providerKey) {
      return adapters.has(key(capability, providerKey));
    },

    /** @param {string} [capability] filter; omit for every registration */
    list(capability) {
      const out = [];
      for (const [entryKey, adapter] of adapters) {
        const [entryCapability] = entryKey.split(':');
        if (capability && entryCapability !== capability) continue;
        out.push({ capability: entryCapability, providerKey: entryKey.slice(entryCapability.length + 1), adapter });
      }
      return out;
    },

    unregister(capability, providerKey) {
      return adapters.delete(key(capability, providerKey));
    },

    clear() {
      adapters.clear();
    },
  };
}

// Process-wide singleton — populated by each capability's bootstrap during
// Phase 3+. Kept empty here so Phase 2 changes no runtime behaviour.
export const providerRegistry = createProviderRegistry();
