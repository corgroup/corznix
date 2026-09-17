import { AppError } from '../../utils/errors.js';
import { normalizePhone } from '../../utils/normalize.js';

// The pickup contact is the human a carrier's pickup agent calls when they
// cannot find, or cannot get into, the warehouse. It therefore comes from the
// ALLOCATED WAREHOUSE record — never the customer's phone, never a global
// default — and an incomplete one is refused at the gate rather than sent to
// the provider half-filled.
//
// Canonical storage is +91XXXXXXXXXX (migration 089 enforces the shape with a
// CHECK constraint). Provider-specific formatting stays inside the adapters:
// nothing outside this file should be reformatting a stored number.

/** Indian mobile in canonical +91XXXXXXXXXX form. */
const CANONICAL = /^\+91[6-9]\d{9}$/;

/**
 * Accept what an operator would actually type — 9278092710, 09278092710,
 * +91 92780 92710, 91-9278092710 — and return the one canonical form, or ''
 * when it is not a valid Indian mobile. Never returns a partial string.
 */
export function canonicalPickupPhone(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  // A leading 0 is a domestic trunk prefix, not part of the number.
  const digits = raw.replace(/\D+/g, '').replace(/^0+/, '');
  const ten = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
  if (!/^[6-9]\d{9}$/.test(ten)) return '';
  const e164 = normalizePhone(ten); // libphonenumber validation, not a regex guess
  return CANONICAL.test(e164) ? e164 : '';
}

export function isValidPickupPhone(value) {
  return CANONICAL.test(String(value ?? ''));
}

/**
 * Normalise the contact fields on a warehouse create/update patch in place of
 * whatever the operator typed. Throws on a value that is present but unusable
 * — silently dropping a bad number is how an unreachable warehouse gets
 * enabled for pickup.
 */
export function normalizeWarehouseContactPatch(patch = {}) {
  const out = { ...patch };
  for (const field of ['contactPhone', 'contactPhoneAlt']) {
    if (!(field in out)) continue;
    const raw = out[field];
    if (raw === null || String(raw).trim() === '') {
      out[field] = null;
      continue;
    }
    const canonical = canonicalPickupPhone(raw);
    if (!canonical) {
      throw new AppError(
        'WAREHOUSE_CONTACT_PHONE_INVALID',
        `${field === 'contactPhone' ? 'Pickup contact mobile' : 'Alternate mobile'} must be a valid 10-digit Indian mobile number.`,
        400,
      );
    }
    out[field] = canonical;
  }
  return out;
}

/**
 * The gate. A warehouse cannot be enabled for fulfilment/pickup, and cannot
 * have a pickup raised against it, without a reachable contact.
 *
 * @param {object} warehouse  a raw `warehouses` row
 * @param {'ACTIVATION'|'PICKUP'} context  shapes the operator-facing message
 */
export function assertPickupContact(warehouse, context = 'PICKUP') {
  const name = String(warehouse?.contact_name ?? '').trim();
  const phone = String(warehouse?.contact_phone ?? '').trim();
  const label = warehouse?.name || warehouse?.code || 'This warehouse';

  if (!phone) {
    throw new AppError(
      'WAREHOUSE_PICKUP_CONTACT_MISSING',
      context === 'ACTIVATION'
        ? `${label} needs a pickup contact mobile number before it can be enabled for fulfilment.`
        : `${label} has no pickup contact mobile number. Add one in Warehouses before requesting a carrier pickup — the pickup agent has no way to reach the warehouse without it.`,
      409,
      { warehouseId: warehouse?.id ?? null, field: 'contactPhone' },
    );
  }
  if (!isValidPickupPhone(phone)) {
    throw new AppError(
      'WAREHOUSE_PICKUP_CONTACT_INVALID',
      `${label} has an invalid pickup contact mobile number (${phone}). Correct it in Warehouses — it must be a 10-digit Indian mobile.`,
      409,
      { warehouseId: warehouse?.id ?? null, field: 'contactPhone' },
    );
  }
  if (!name) {
    throw new AppError(
      'WAREHOUSE_PICKUP_CONTACT_NAME_MISSING',
      `${label} needs a pickup contact person's name before a carrier pickup can be requested.`,
      409,
      { warehouseId: warehouse?.id ?? null, field: 'contactName' },
    );
  }
  return { name, phone, alt: String(warehouse?.contact_phone_alt ?? '').trim() || null };
}

/** Non-throwing form, for read surfaces that want to show readiness. */
export function pickupContactStatus(warehouse) {
  try {
    const contact = assertPickupContact(warehouse, 'PICKUP');
    return { ready: true, ...contact, reason: null };
  } catch (err) {
    return {
      ready: false,
      name: warehouse?.contact_name || null,
      phone: warehouse?.contact_phone || null,
      alt: warehouse?.contact_phone_alt || null,
      reason: err.code,
      message: err.message,
    };
  }
}
