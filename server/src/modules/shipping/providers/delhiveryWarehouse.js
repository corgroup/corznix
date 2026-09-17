// Delhivery client-warehouse (pickup location) registration.
//
// Contract — implementation/phase-02/01-provider-contract-evidence.md rows 13/14:
//   13  Warehouse Create  POST /api/backend/clientwarehouse/create/
//       mandatory: name, phone, pin, return_address.  RL 10/min/IP.
//       `name` is case- and space-SENSITIVE and becomes `pickup_location`
//       in every later manifest — it is the join key between CORCOTTON and
//       Delhivery, so it is never normalised, trimmed or case-folded here.
//   14  Warehouse Edit    POST /api/backend/clientwarehouse/edit/
//       mandatory: name, pin.  editable: address, phone.  RL 10/min/IP.
//       `name` is IMMUTABLE — Delhivery offers no rename. A CORCOTTON
//       warehouse whose mapping exists therefore cannot be renamed either;
//       adminWarehouses.update enforces that.
//
// There is deliberately NO read/list counterpart: the provider contract
// documents 18 endpoints and none of them returns a warehouse. Delhivery ->
// CORCOTTON reconciliation is impossible over the API, so this module only
// ever PUSHES, and the caller must treat CORCOTTON as the source of truth.

const req = (value, field) => {
  const v = value == null ? '' : String(value).trim();
  if (!v) throw new Error(`DELHIVERY_WAREHOUSE_FIELD_REQUIRED:${field}`);
  return v;
};

const opt = (value) => {
  const v = value == null ? '' : String(value).trim();
  return v || undefined;
};

// CORCOTTON stores pickup contacts in E.164 (+919278092710) — the CMS says so
// on the field itself, and that each carrier gets whatever format it needs.
// Delhivery is one of the carriers that does NOT: its warehouse contract and
// its own panel both carry a bare 10-digit number, so an E.164 value goes over
// as an unrecognised phone. Reduced to the last ten digits when it is clearly
// an Indian number, and otherwise passed through untouched rather than
// mangling something we do not understand.
const carrierPhone = (value) => {
  const raw = value == null ? '' : String(value).trim();
  if (!raw) return raw;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return raw;
};

/**
 * A CORCOTTON warehouse row -> the Delhivery create payload.
 *
 * `name` is passed through verbatim (see above). The return address defaults
 * to the pickup address, which is what a single-location seller wants and is
 * exactly how Delhivery treats an omitted return block.
 */
export function buildWarehouseCreatePayload(warehouse = {}, { returnAddress = null } = {}) {
  const ret = returnAddress ?? warehouse;
  const address = req(
    [warehouse.addressLine1, warehouse.addressLine2].filter(Boolean).join(', '),
    'address',
  );
  return {
    name: req(warehouse.providerLocationName ?? warehouse.code, 'name'),
    registered_name: opt(warehouse.contactName) ?? req(warehouse.name, 'registered_name'),
    email: opt(warehouse.contactEmail),
    phone: carrierPhone(req(warehouse.contactPhone, 'phone')),
    address,
    city: opt(warehouse.city),
    state: opt(warehouse.state),
    country: opt(warehouse.country) ?? 'India',
    pin: req(warehouse.postalCode, 'pin'),
    return_address: req(
      [ret.addressLine1, ret.addressLine2].filter(Boolean).join(', ') || address,
      'return_address',
    ),
    return_pin: req(ret.postalCode ?? warehouse.postalCode, 'return_pin'),
    return_city: opt(ret.city ?? warehouse.city),
    return_state: opt(ret.state ?? warehouse.state),
    return_country: opt(ret.country ?? warehouse.country) ?? 'India',
  };
}

/**
 * The edit payload. Only the fields Delhivery accepts as editable are sent;
 * `name` travels as the identifier, never as a new value.
 */
export function buildWarehouseEditPayload(providerLocationName, patch = {}) {
  const body = {
    name: req(providerLocationName, 'name'),
    pin: req(patch.postalCode, 'pin'),
  };
  const address = [patch.addressLine1, patch.addressLine2].filter(Boolean).join(', ');
  if (address) body.address = address;
  const phone = opt(patch.contactPhone);
  if (phone) body.phone = carrierPhone(phone);
  return body;
}

/**
 * Delhivery answers these two endpoints with a loose envelope. The doc does not
 * pin the success shape, so — same rule as every other parser in this
 * directory — we look across the plausible fields and FAIL LOUD rather than
 * assume success from a 200. A registration we cannot prove must never be
 * written to `warehouse_provider_locations`.
 */
export function parseWarehouseResponse(data) {
  if (data == null || typeof data !== 'object') throw new Error('SHIPPING_PROVIDER_RESPONSE_INVALID');

  const errorText = firstString(data, ['error', 'errors', 'rmk', 'remark', 'message']);

  const success = data.success ?? data.Success ?? data.status ?? data.Status;
  const ok = success === true
    || success === 'true'
    || success === 'True'
    || (typeof success === 'string' && success.toLowerCase() === 'success');

  if (!ok) {
    const e = new Error('SHIPPING_PROVIDER_REJECTED');
    e.providerMessage = errorText || null;
    throw e;
  }

  const node = data.data ?? data.Data ?? data;
  return {
    providerLocationName: firstString(node, ['name', 'warehouse_name', 'pickup_location']) ?? null,
    registeredAt: new Date(),
    raw: { message: errorText || null },
  };
}

function firstString(node, keys) {
  if (node == null || typeof node !== 'object') return null;
  for (const k of keys) {
    const v = node[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (Array.isArray(v) && v.length && typeof v[0] === 'string' && v[0].trim()) return v[0].trim();
  }
  return null;
}
