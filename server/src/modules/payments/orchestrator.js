import { AppError } from '../../utils/errors.js';

// Which gateway takes a payment. The customer picks one on the Payment Method
// step; only gateways that can take a payment right now are offered — enabled
// in the CMS, built, and configured — in the CMS priority order.
export class PaymentOrchestrator {
  constructor({ repository, registry }) { this.repository = repository; this.registry = registry; }

  async availableProviders() {
    const configs = await this.repository.enabledProviders();
    return configs
      .map((config) => this.registry.resolve(config.provider_code))
      .filter((provider) => provider?.implemented && provider.configured);
  }

  async selectProvider(preferredCode = null) {
    const available = await this.availableProviders();
    if (!available.length) throw new AppError('PAYMENT_PROVIDER_UNAVAILABLE', 'No payment provider is configured.', 503);
    if (!preferredCode) return available[0];
    const chosen = available.find((provider) => provider.code === preferredCode);
    if (!chosen) throw new AppError('PAYMENT_PROVIDER_UNAVAILABLE', 'The selected payment method is not available right now. Please choose another.', 409);
    return chosen;
  }

  async create(attempt, request) {
    // The attempt already names its gateway; it must still be able to take a payment.
    const provider = await this.selectProvider(attempt.provider_code);
    try { return await provider.createPaymentSession(request); }
    catch (err) {
      // A gateway refusing to open a session is not a fault in CORCOTTON, and
      // it must not reach the customer as "an unexpected error occurred" — that
      // reads as our bug and tells them nothing about what to do. It becomes a
      // 502 with a plain, honest sentence; the provider's own words stay in the
      // log for whoever has to fix the account, never in the response.
      if (err?.message === 'PAYMENT_PROVIDER_NOT_CONFIGURED') throw new AppError('PAYMENT_PROVIDER_UNAVAILABLE', 'Online payment is not available right now. Please try again shortly.', 503);
      if (err?.message === 'PAYMENT_PROVIDER_REJECTED') {
        const wrapped = new AppError('PAYMENT_PROVIDER_UNAVAILABLE', 'Online payment is temporarily unavailable. Please try again in a few minutes, or contact us if it continues.', 502);
        wrapped.providerMessage = err.providerMessage || null;
        throw wrapped;
      }
      throw err;
    }
  }
}
