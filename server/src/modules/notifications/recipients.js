import { CustomerContactRepository } from '../customers/repositories.js';

// WP-05 — resolve the recipient contact for a channel.
//
// TWO SOURCES, in priority order:
//
//   1. The ORDER's own contact (shipping_address_snapshot). A transactional
//      message about an order goes to the phone/name the customer typed at
//      checkout FOR THAT ORDER — not to whatever is on their profile. A
//      customer who ordered for a relative, or who typed a different number
//      at checkout, must be reached on the number they gave. Silently using a
//      profile or default number instead is how the wrong person gets told
//      about someone else's delivery.
//
//   2. The customer's verified profile contact, for events with no order
//      context (account-level notices).
//
// The order override applies to TRANSACTIONAL messages only. Marketing still
// requires a verified profile contact plus consent — a checkout phone is
// permission to talk about that order, not permission to advertise.
//
// customer_contacts only holds 'EMAIL' and 'PHONE' (003_customer_auth.sql);
// WhatsApp uses PHONE, stored E.164, which is what the Infyntra adapter's
// formatInfyntraDestination expects.

const contactRepo = new CustomerContactRepository();

const CHANNEL_CONTACT_TYPE = Object.freeze({ EMAIL: 'EMAIL', WHATSAPP: 'PHONE' });

/**
 * Indian mobile -> +91XXXXXXXXXX. Checkout stores whatever the customer typed
 * ("9319987171", "+91 93199 87171", "09319987171"); the provider needs one
 * canonical form. Anything that is not a valid Indian mobile returns null so
 * the caller falls back rather than sending to a malformed destination.
 */
export function normalizeIndianMobile(raw) {
  const digits = String(raw ?? '').replace(/[^0-9]/g, '');
  const ten = digits.length === 12 && digits.startsWith('91') ? digits.slice(2)
    : digits.length === 11 && digits.startsWith('0') ? digits.slice(1)
      : digits.length === 10 ? digits
        : null;
  return ten && /^[6-9][0-9]{9}$/.test(ten) ? `+91${ten}` : null;
}

/** The order's own contact, from its shipping snapshot. */
export function orderContactFrom(snapshot) {
  if (!snapshot) return null;
  const snap = typeof snapshot === 'string' ? safeParse(snapshot) : snapshot;
  if (!snap) return null;
  const name = [snap.firstName, snap.lastName].filter(Boolean).join(' ').trim();
  return {
    name: name || null,
    phone: normalizeIndianMobile(snap.phone),
    email: snap.email || null,
  };
}

function safeParse(value) {
  try { return JSON.parse(value); } catch { return null; }
}

/**
 * @param {string|null} customerId
 * @param {'EMAIL'|'WHATSAPP'} channel
 * @param {{orderContact?: {name?:string|null, phone?:string|null, email?:string|null}|null,
 *          classification?: string}} [options]
 * @returns {Promise<{ customerId: string|null, contactKey: string, source: string } | null>}
 */
export async function resolveRecipient(customerId, channel, options = {}) {
  const wantedType = CHANNEL_CONTACT_TYPE[channel];
  if (!wantedType) return null;

  const { orderContact = null, classification = 'TRANSACTIONAL' } = options;

  // 1. The contact given for THIS order.
  if (orderContact && classification === 'TRANSACTIONAL') {
    const key = channel === 'WHATSAPP' ? orderContact.phone : orderContact.email;
    if (key) return { customerId: customerId ?? null, contactKey: key, source: 'ORDER_CONTACT' };
  }

  // 2. The verified profile contact.
  if (!customerId) return null;
  const contacts = await contactRepo.findForCustomer(customerId);
  const match = contacts.find((c) => c.contact_type === wantedType && c.is_verified);
  return match ? { customerId, contactKey: match.normalized_value, source: 'PROFILE_VERIFIED' } : null;
}
