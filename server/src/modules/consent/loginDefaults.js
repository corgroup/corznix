import { logger } from '../../utils/logger.js';
import { consentService } from './service.js';

const log = logger('consent');

/**
 * Apply default-ON marketing after a customer has signed in or verified a
 * contact (see consentService.applyDefaultMarketing: only verified contacts,
 * only channels never decided, an OFF is never overridden).
 *
 * Called from the HTTP layer AFTER authentication has already succeeded —
 * never from auth/service.js, which must stay free of consent logic so
 * marketing can never influence whether someone can log in (§9, guarded by
 * verify:consent-newsletter). A failure here does not undo the login; it is
 * logged loudly, and the next sign-in or the baseline job applies it.
 */
export async function applyDefaultMarketingAfterSignIn(customerId) {
  if (!customerId) return [];
  try {
    return await consentService.applyDefaultMarketing(customerId, 'DEFAULT_ON_SIGNUP');
  } catch (error) {
    log.error('default_marketing_consent_failed', { customerId, error: error.message });
    return [];
  }
}
