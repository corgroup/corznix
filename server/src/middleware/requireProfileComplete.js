// ADAPTED_SOURCE_TO_TARGET from
// corcotton-store/server/src/middleware/requireProfileComplete.js
// (Wave 5).
//
// BUG FIX (this wave's security/correctness review — see file banner in
// modules/auth/service.js): the source version checked
// `req.customer.profile_complete`, but `req.customer` is the raw
// `customers` table row (set by `authenticate.js` from
// `CustomerRepository.findById`), which has no `profile_complete` column
// at all — only `status`. That check was always `undefined` -> always
// falsy, so this middleware would have rejected EVERY request regardless
// of actual profile state. Fixed to compute completeness for real, via the
// one shared `profileService.getRequiredFields` (see
// modules/customers/profileService.js) — consistent with every other
// profile-completeness check in this codebase.
import { AppError } from '../utils/errors.js';
import { CustomerContactRepository, CustomerIdentityRepository } from '../modules/customers/repositories.js';
import { getRequiredFields } from '../modules/customers/profileService.js';

const contactRepository = new CustomerContactRepository();
const identityRepository = new CustomerIdentityRepository();

export async function requireProfileComplete(req, res, next) {
  try {
    if (!req.customer) {
      throw new AppError('AUTH_REQUIRED', 'Authentication required.', 401);
    }
    const [contacts, identities] = await Promise.all([
      contactRepository.findForCustomer(req.customer.id),
      identityRepository.findByCustomer(req.customer.id),
    ]);
    const required = getRequiredFields(req.customer, identities, contacts);
    if (required.length > 0) {
      throw new AppError('PROFILE_INCOMPLETE', 'Profile completion is required.', 403, { requiredFields: required });
    }
    next();
  } catch (error) {
    next(error);
  }
}
