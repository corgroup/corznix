// Shared provider-platform primitives (Provider Platform Migration, Phase 2).
//
// Additive only — importing this module changes no runtime behaviour. Each
// capability (media, logistics, payments, notifications, auth-providers) is
// migrated onto these primitives in a later, isolated phase.

export {
  ProviderError,
  PROVIDER_ERROR_CODES,
  createProviderError,
  providerErrorFromHttpStatus,
  providerErrorToAppError,
} from './providerError.js';

export {
  CAPABILITIES,
  CAPABILITY_REQUIRED_METHODS,
  assertAdapterConformance,
} from './adapterContract.js';

export {
  createProviderRegistry,
  providerRegistry,
} from './providerRegistry.js';

export {
  staticConfigSource,
  setProviderConfigSource,
  getProviderConfig,
  getEnabledProviders,
  isProviderEnabled,
} from './providerConfig.js';

export {
  redact,
  logProviderCall,
  withProviderCall,
} from './providerLogging.js';

export {
  providerFetch,
  providerFetchJson,
} from './providerHttp.js';
