// Media capability bootstrap (Provider Platform Migration, Phase 3).
//
// Registers every media provider adapter into the shared provider registry.
// Idempotent — safe to call from `resolveMediaProvider()` on every request.
// This is the pattern each capability follows in its own phase.
import { providerRegistry, CAPABILITIES } from '../shared/index.js';
import { CloudinaryProvider } from './providers/cloudinary/cloudinaryProvider.js';

let done = false;

export function registerMediaProviders(registry = providerRegistry) {
  if (done && registry === providerRegistry) return registry;
  // One `register` call per provider. `register` runs the media conformance
  // check (upload + remove), so a broken adapter fails here, not on the first
  // upload request.
  if (!registry.has(CAPABILITIES.MEDIA, 'cloudinary')) {
    registry.register(CAPABILITIES.MEDIA, 'cloudinary', new CloudinaryProvider());
  }
  // Future: registry.register(CAPABILITIES.MEDIA, 'r2', new R2Provider());
  if (registry === providerRegistry) done = true;
  return registry;
}
