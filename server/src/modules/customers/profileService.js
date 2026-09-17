// Pure, stateless required-fields calculator — the ONE place "is this
// profile complete, and what's missing" is computed. ADAPTED from
// corcotton-store/server/src/modules/customers/services.js's
// `ProfileService` (Wave 5). The source project computed this same logic
// inline, separately, in four different places (verifyOtp, loginWithGoogle,
// the /session route, and /profile/complete) — consolidated here instead so
// there's exactly one implementation (migration brief §103's Auth/Customer
// boundary: this is customer-profile logic, not auth logic, even though
// AuthService calls it during login).
export const CONTACT_TYPES = Object.freeze({ EMAIL: 'EMAIL', PHONE: 'PHONE' });
export const AUTH_PROVIDERS = Object.freeze({ PHONE_OTP: 'PHONE_OTP', EMAIL_OTP: 'EMAIL_OTP', GOOGLE: 'GOOGLE' });

export function getRequiredFields(customer, identities = [], contacts = []) {
  const required = [];
  if (!(customer.first_name || '').trim()) required.push('firstName');
  if (!(customer.last_name || '').trim()) required.push('lastName');
  if (!contacts.some((c) => c.contact_type === CONTACT_TYPES.EMAIL)) required.push('email');
  if (!contacts.some((c) => c.contact_type === CONTACT_TYPES.PHONE)) required.push('phone');
  return required;
}

/**
 * @returns {{ id, firstName, lastName, profileComplete, requiredFields, email, phone, linkedIdentities }}
 * Never includes an OTP, token, or raw database row — this is the exact
 * shape that reaches the frontend (migration brief §43).
 */
export function buildCustomerProfile(customer, identities = [], contacts = []) {
  const requiredFields = getRequiredFields(customer, identities, contacts);
  const email = contacts.find((c) => c.contact_type === CONTACT_TYPES.EMAIL) || null;
  const phone = contacts.find((c) => c.contact_type === CONTACT_TYPES.PHONE) || null;

  return {
    id: customer.id,
    firstName: customer.first_name || '',
    lastName: customer.last_name || '',
    profileComplete: requiredFields.length === 0,
    requiredFields,
    email: { value: email?.value ?? null, verified: Boolean(email?.is_verified) },
    phone: { value: phone?.value ?? null, verified: Boolean(phone?.is_verified) },
    linkedIdentities: {
      whatsappOtp: identities.some((i) => i.provider === AUTH_PROVIDERS.PHONE_OTP),
      emailOtp: identities.some((i) => i.provider === AUTH_PROVIDERS.EMAIL_OTP),
      google: identities.some((i) => i.provider === AUTH_PROVIDERS.GOOGLE),
    },
  };
}
