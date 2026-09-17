import { pool } from '../src/database/connection/pool.js';
import { LogisticsOrchestrator } from '../src/modules/shipping/orchestrator.js';
import { MockShippingAdapter } from '../src/modules/shipping/providers/mockAdapter.js';
import { ShippingProviderAdapter, PROVIDER_CHOICE_MODES } from '../src/modules/shipping/providerContract.js';
import { ShippingProviderRegistry } from '../src/modules/shipping/registry.js';
import { ShippingService } from '../src/modules/shipping/service.js';

const assert = (value, message) => { if (!value) throw new Error(message); };
const silentLogger = { info() {}, warn() {} };
// Phase 2 — pure test: never let the pricing-policy lookup hit the DB.
const STUB_POLICY = { get: async () => ({ surfaceCustomerChargeMode: "PROVIDER_RATE", expressAdditionalChargeMinor: 0 }) };
const service = (providerServiceCode, level = 'STANDARD', override = null) => ({ providerServiceCode, normalizedServiceLevel: level, displayName: `${level} Shipping`, enabled: true, customerVisible: true, rateOverrideMinor: override });
const provider = (providerCode, priority, services, extra = {}) => ({ providerCode, displayName: providerCode, enabled: true, priority, customerVisible: true, eligibleForZone: true, services, ...extra });
const configuration = (providers, mode = PROVIDER_CHOICE_MODES.BACKEND_SELECTED) => ({ providerChoiceMode: mode, quoteTtlSeconds: 900, providers });
const configService = (value) => ({ async getConfiguration() { return value; } });

class TestAdapter extends ShippingProviderAdapter {
  constructor(code, quote) { super({ providerCode: code, configured: true }); this.handler = quote; this.calls = 0; }
  async quote(request, options) { this.calls += 1; return this.handler(request, options); }
}
const result = (code, services) => ({ providerCode: code, serviceable: services !== null, services: services || [] });
const quote = (providerServiceCode, rateMinor, extra = {}) => ({ providerServiceCode, rateMinor, estimatedDeliveryAt: null, estimatedDays: 3, codSupported: true, metadata: {}, ...extra });
const request = { destinationPostalCode: '110001', items: [], contextType: 'PRODUCT', shipmentValueMinor: null };

async function expectCode(promise, code, message) {
  await promise.then(() => { throw new Error(message); }, (error) => assert(error.code === code, `${message}: ${error.code}`));
}

async function main() {
  const a = new TestAdapter('A', async () => result('A', [quote('A_STANDARD', 7900), quote('A_EXPRESS', 12900)]));
  const b = new TestAdapter('B', async () => result('B', [quote('B_STANDARD', 9900)]));
  const registry = new ShippingProviderRegistry([a, b]);
  assert(registry.resolve('A') === a && registry.status('MISSING') === 'NOT_IMPLEMENTED', 'Provider registry failed');

  const providers = [provider('A', 2, [service('A_STANDARD'), service('A_EXPRESS', 'EXPRESS')]), provider('B', 1, [service('B_STANDARD')])];
  let orchestrator = new LogisticsOrchestrator({ configurationService: configService(configuration(providers)), registry, logger: silentLogger, pricingPolicy: STUB_POLICY });
  let value = await orchestrator.quote(request);
  assert(value.methods.length === 2 && value.methods[0].options[0].providerCode === 'B', 'Backend-selected priority routing failed');
  assert(value.methods[1].options[0].providerServiceCode === 'A_EXPRESS', 'EXPRESS normalization failed');

  orchestrator = new LogisticsOrchestrator({ configurationService: configService(configuration(providers, PROVIDER_CHOICE_MODES.CUSTOMER_VISIBLE)), registry, logger: silentLogger, pricingPolicy: STUB_POLICY });
  value = await orchestrator.quote(request);
  assert(value.methods[0].options.length === 2 && value.methods[1].options.length === 1, 'Customer-visible multi-provider grouping failed');

  const overrideAdapter = new TestAdapter('OVERRIDE', async () => result('OVERRIDE', [quote('S', 9900)]));
  value = await new LogisticsOrchestrator({ configurationService: configService(configuration([provider('OVERRIDE', 1, [service('S','STANDARD',6900)])])), registry: new ShippingProviderRegistry([overrideAdapter]), logger: silentLogger, pricingPolicy: STUB_POLICY }).quote(request);
  assert(value.methods[0].options[0].rateMinor === 6900 && value.methods[0].options[0].rateSource === 'BUSINESS_OVERRIDE', 'Rate authority/override failed');

  const success = new TestAdapter('SUCCESS', async () => result('SUCCESS', [quote('S', 7900)]));
  const failure = new TestAdapter('FAILURE', async () => { throw new Error('provider failed'); });
  value = await new LogisticsOrchestrator({ configurationService: configService(configuration([provider('SUCCESS',1,[service('S')]),provider('FAILURE',2,[service('F')])], PROVIDER_CHOICE_MODES.CUSTOMER_VISIBLE)), registry: new ShippingProviderRegistry([success,failure]), logger: silentLogger, pricingPolicy: STUB_POLICY }).quote(request);
  assert(value.serviceable && value.failures === 1, 'Partial provider failure failed');

  await expectCode(new LogisticsOrchestrator({ configurationService: configService(configuration([provider('FAILURE',1,[service('F')])])), registry: new ShippingProviderRegistry([failure]), logger: silentLogger, pricingPolicy: STUB_POLICY }).quote(request), 'SHIPPING_PROVIDER_UNAVAILABLE', 'All-provider failure misclassified');
  const slow = new TestAdapter('SLOW', async () => new Promise(() => {}));
  await expectCode(new LogisticsOrchestrator({ configurationService: configService(configuration([provider('SLOW',1,[service('S')])])), registry: new ShippingProviderRegistry([slow]), timeoutMs: 10, logger: silentLogger, pricingPolicy: STUB_POLICY }).quote(request), 'SHIPPING_PROVIDER_UNAVAILABLE', 'Provider timeout misclassified');

  const no = new TestAdapter('NO', async () => result('NO', null));
  value = await new LogisticsOrchestrator({ configurationService: configService(configuration([provider('NO',1,[service('NO')])])), registry: new ShippingProviderRegistry([no]), logger: silentLogger, pricingPolicy: STUB_POLICY }).quote(request);
  assert(!value.serviceable && value.status === 'UNSERVICEABLE', 'Unserviceable result misclassified');

  const disabled = new TestAdapter('DISABLED', async () => result('DISABLED', [quote('D',1)]));
  const unavailable = new TestAdapter('UNCONFIGURED', async () => result('UNCONFIGURED', [quote('U',1)])); unavailable.configured = false;
  value = await new LogisticsOrchestrator({ configurationService: configService(configuration([provider('DISABLED',1,[service('D')],{enabled:false}),provider('UNCONFIGURED',2,[service('U')]),provider('SUCCESS',3,[service('S')])])), registry: new ShippingProviderRegistry([disabled,unavailable,success]), logger: silentLogger, pricingPolicy: STUB_POLICY }).quote(request);
  assert(disabled.calls === 0 && unavailable.calls === 0 && value.serviceable, 'Disabled/unconfigured provider eligibility failed');

  const mockProduction = new MockShippingAdapter({ runtimeEnv: { SHIPPING_PROVIDER_MODE: 'MOCK', SHIPPING_STANDARD_CHARGE_MINOR: 0 }, production: true });
  assert(!mockProduction.configured, 'MOCK production guard failed');

  const spy = { calls: [], async quote(input) { this.calls.push(input.contextType); return { postalCode: input.destinationPostalCode, serviceable: true, status: 'SERVICEABLE', providerChoiceMode: 'BACKEND_SELECTED', quoteIssuedAt: new Date().toISOString(), quoteExpiresAt: new Date(Date.now()+60000).toISOString(), methods: [], failures: 0 }; } };
  const sharedService = new ShippingService({ orchestrator: spy, configurationService: {}, registry: new ShippingProviderRegistry() });
  await sharedService.quote({ postalCode: '110001', contextType: 'PRODUCT' }); await sharedService.quote({ postalCode: '110001', contextType: 'CHECKOUT' });
  assert(spy.calls.join(',') === 'PRODUCT,CHECKOUT', 'PDP/Checkout did not reuse ShippingService');
  await expectCode(sharedService.quote({ postalCode: '12345' }), 'INVALID_POSTAL_CODE', 'PIN validation failed');

  const publicJson = JSON.stringify(sharedService.toPublic({ ...value, informational: true, shippingDataGap: 'SHIPPING_DIMENSION_DATA_GAP' }));
  assert(!/token|secret|apiKey/i.test(publicJson), 'Provider secret field exposed');
  const selectable = await new LogisticsOrchestrator({ configurationService: configService(configuration([provider('SUCCESS',1,[service('S')])])), registry: new ShippingProviderRegistry([success]), logger: silentLogger, pricingPolicy: STUB_POLICY }).quote(request);
  const shipping = new ShippingService({ orchestrator: {}, configurationService: {}, registry: new ShippingProviderRegistry() });
  const option = shipping.resolveQuote(selectable, selectable.methods[0].options[0].quoteId);
  assert(option.rateMinor === 7900, 'Quote resolution failed');
  await expectCode(Promise.resolve().then(() => shipping.resolveQuote(selectable, '00000000-0000-4000-8000-000000000000')), 'INVALID_SHIPPING_OPTION', 'Invalid quote accepted');
  const expired = structuredClone(selectable); expired.methods[0].options[0].quoteExpiresAt = '2000-01-01T00:00:00.000Z';
  await expectCode(Promise.resolve().then(() => shipping.resolveQuote(expired, expired.methods[0].options[0].quoteId)), 'SHIPPING_QUOTE_EXPIRED', 'Expired quote accepted');

  console.log(JSON.stringify({ providerRegistry:'PASS',disabledProvider:'SKIPPED',unconfiguredProvider:'SKIPPED',timeout:'PASS',partialFailure:'PASS',allProviderFailure:'PASS',unserviceable:'PASS',multipleProviders:'PASS',standardMapping:'PASS',expressMapping:'PASS',backendSelected:'PASS',customerVisible:'PASS',priorityRouting:'PASS',rateAuthority:'PASS',invalidOption:'REJECTED',expiredQuote:'REJECTED',pdpReuse:'PASS',checkoutReuse:'PASS',mockProductionGuard:'PASS',providerSecretsExposed:'NO',shippingDimensionDataGap:'REPORTED' }, null, 2));
  await pool.end();
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
