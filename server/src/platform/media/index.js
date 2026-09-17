// Media Abstraction entrypoint. `MEDIA_PROVIDER` is read here (and only here)
// and resolved to an adapter via the shared provider registry
// (server/src/platform/shared) — blueprint §7/§49: business modules must not
// read `MEDIA_PROVIDER` or import a provider directly.
//
// Phase 3 (Provider Platform Migration): the old local `switch (name)` mini
// resolver was replaced by `providerRegistry.get(...)`. The Cloudinary adapter,
// mapper, config and `NormalizedMedia` contract are otherwise unchanged. Add a
// provider by registering it in `bootstrap.js` — nothing else changes.
import { env } from '../../config/index.js';
import { providerRegistry, CAPABILITIES } from '../shared/index.js';
import { registerMediaProviders } from './bootstrap.js';

/** @returns {import('./contracts/mediaProvider.js').MediaProvider} */
export function resolveMediaProvider() {
  registerMediaProviders();
  return providerRegistry.get(CAPABILITIES.MEDIA, env.MEDIA_PROVIDER);
}

export * from './services/mediaService.js';
export { registerMediaProviders } from './bootstrap.js';
