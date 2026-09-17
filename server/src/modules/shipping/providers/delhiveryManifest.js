// Phase 2 · Slice 10 — Delhivery shipment-creation (manifest) payload builder
// and response parser for POST /api/cmu/create.json.
//
// Every field traces to Dev_API.docx (implementation/phase-02/
// 01-provider-contract-evidence.md § Create payload). Kept out of the adapter
// so it is pure and unit-testable. CORCOTTON forward flow = SPS (single piece,
// one waybill) with Prepaid / COD only.

const FORBIDDEN_RAW_CHARS = /[&#%;\\]/; // raw JSON must not contain these — url-encode the whole `data` value

// One printed line on the carrier's label, measured from a real parcel: past
// this the text reaches the order barcode underneath it.
const RETURN_ADDRESS_MAX = 60;

/**
 * A single-line address for a fixed-width strip: repeated parts dropped
 * (warehouse rows really do read "Parasupur, Parasupur"), whitespace collapsed,
 * and cut at a word boundary rather than mid-word.
 */
export function compactAddressLine(value, max = RETURN_ADDRESS_MAX) {
  const parts = String(value || '')
    .split(',')
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const seen = new Set();
  const unique = parts.filter((p) => {
    const key = p.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const line = unique.join(', ');
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const lastBreak = Math.max(cut.lastIndexOf(', '), cut.lastIndexOf(' '));
  return (lastBreak > max * 0.5 ? cut.slice(0, lastBreak) : cut).replace(/[,\s]+$/, '');
}

/**
 * @param {object} request provider-neutral, from ShipmentBookingService:
 *   {
 *     clientReference, orderReference,
 *     pickupLocationName,                        // exact registered Delhivery WH name
 *     origin:  { name, address, city, state, postalCode, phone, returnName, returnAddress, returnPostalCode },
 *     destination: { name, phone, address, city, state, postalCode, country },
 *     package: { weightGrams, lengthMm, widthMm, heightMm },
 *     payment: { mode: 'PREPAID'|'COD', codCollectionMinor, orderValueMinor },
 *     serviceLevel: 'STANDARD'|'EXPRESS',
 *     productsDesc, quantity, hsnCode, sellerInvoice,
 *   }
 * @returns {{ dataObject: object }}
 */
export function buildManifestPayload(request) {
  const errors = [];
  const dst = request.destination || {};
  const pkg = request.package || {};
  const pay = request.payment || {};
  const org = request.origin || {};

  const req = (v, field) => { if (v == null || String(v).trim() === '') errors.push(field); return v; };

  const cod = pay.mode === 'COD';
  const weightGrams = Number(pkg.weightGrams);
  if (!Number.isFinite(weightGrams) || weightGrams <= 0) errors.push('package.weightGrams');

  const shipment = {
    name: req(dst.name, 'destination.name'),
    order: req(request.orderReference, 'orderReference'),
    phone: req(providerPhone(dst.phone), 'destination.phone'),
    add: req(dst.address, 'destination.address'),
    pin: req(dst.postalCode, 'destination.postalCode'),
    city: dst.city || '',
    state: dst.state || '',
    country: dst.country || 'India',
    payment_mode: cod ? 'COD' : 'Prepaid',
    cod_amount: cod ? minorToRupeeString(pay.codCollectionMinor) : '',
    total_amount: minorToRupeeString(pay.orderValueMinor),
    weight: Number.isFinite(weightGrams) && weightGrams > 0 ? String(Math.round(weightGrams)) : '',
    // mm -> cm, provider-only (brief §37). Optional — omit if not confirmed.
    shipment_length: mmToCmString(pkg.lengthMm),
    shipment_width: mmToCmString(pkg.widthMm),
    shipment_height: mmToCmString(pkg.heightMm),
    shipping_mode: request.serviceLevel === 'EXPRESS' ? 'Express' : 'Surface',
    products_desc: request.productsDesc || '',
    quantity: request.quantity == null ? '' : String(request.quantity),
    hsn_code: request.hsnCode || '',
    seller_inv: request.sellerInvoice || '',
    // The invoiced legal supplier when we have one; the warehouse's display
    // name is only a fallback (it is a location, not a legal seller).
    seller_name: request.sellerLegalName || org.name || '',
    // The seller block on the carrier's label wraps over several lines, so the
    // full GST billing address belongs here — that is what a buyer, and a tax
    // officer, expects to read on the parcel.
    seller_add: request.sellerAddress || org.address || '',
    return_name: org.returnName || org.name || '',
    // The return strip does NOT wrap: it is a single line printed directly
    // above the order barcode, and a long address ran straight over the bars
    // (reported from a real parcel). City, state and PIN are separate fields
    // on the same strip, so this only carries the street part — deduplicated
    // and capped so it can never reach the barcode again.
    return_address: compactAddressLine(org.returnAddress || org.address, RETURN_ADDRESS_MAX),
    return_city: org.returnCity || org.city || '',
    return_state: org.returnState || org.state || '',
    return_country: 'India',
    return_phone: providerPhone(org.returnPhone || org.phone) || '',
    return_pin: org.returnPostalCode || org.postalCode || '',
    waybill: '', // SPS — Delhivery auto-assigns
    address_type: dst.addressType || '',
  };

  const pickupName = req(request.pickupLocationName, 'pickupLocationName');

  if (errors.length) {
    const err = new Error(`MANIFEST_PAYLOAD_INCOMPLETE:${errors.join(',')}`);
    err.code = 'MANIFEST_PAYLOAD_INCOMPLETE';
    err.missing = errors;
    throw err;
  }

  const dataObject = { shipments: [shipment], pickup_location: { name: pickupName } };
  return { dataObject };
}

/** `format=json&data=<url-encoded JSON>` — the documented body form. */
export function encodeManifestBody(dataObject) {
  const json = JSON.stringify(dataObject);
  // Even though we always url-encode, assert the invariant the doc calls out so
  // a regression that sends raw JSON is caught in tests.
  const hasForbidden = FORBIDDEN_RAW_CHARS.test(json);
  const body = `format=json&data=${encodeURIComponent(json)}`;
  return { body, hadForbiddenRawChars: hasForbidden };
}

/**
 * Parse the create.json response. The doc does not field-spec the body; the
 * observed SPS shape is `{ packages: [{ waybill, status, ... }], success }`.
 * Look across plausible shapes; FAIL LOUD if no waybill is present on an
 * apparent success — never fabricate an AWB.
 * @returns {{ ok: true, awb, providerShipmentId, remark }
 *          | { ok: false, code, remark }}
 */
export function parseManifestResponse(data) {
  if (data == null || typeof data !== 'object') return { ok: false, code: 'PROVIDER_RESPONSE_INVALID', remark: null };

  const pkgList = Array.isArray(data.packages) ? data.packages
    : Array.isArray(data.data) ? data.data
      : Array.isArray(data.shipments) ? data.shipments : null;
  const pkg = pkgList && pkgList[0] && typeof pkgList[0] === 'object' ? pkgList[0] : null;

  const awb = firstString(pkg, ['waybill', 'awb', 'awb_number', 'wbn'])
    || firstString(data, ['waybill', 'awb']);
  const remark = firstString(pkg, ['remarks', 'remark', 'rmk', 'message'])
    || firstString(data, ['rmk', 'remark', 'error', 'message']);
  const providerShipmentId = firstString(pkg, ['refnum', 'ref_num', 'reference', 'client', 'order'])
    || awb;

  const successFlag = data.success === true || (pkg && (pkg.success === true || String(pkg.status || '').toLowerCase() === 'success'));
  const failureFlag = data.success === false || (pkg && pkg.success === false);

  if (awb) {
    return { ok: true, awb, providerShipmentId, remark: remark || null };
  }
  if (failureFlag || (successFlag && !awb)) {
    return { ok: false, code: 'PROVIDER_REJECTED', remark: remark || null };
  }
  return { ok: false, code: 'PROVIDER_RESPONSE_INVALID', remark: remark || null };
}

/**
 * Delhivery's manifest expects a bare national number, which is the format
 * this integration has always sent. CORCOTTON stores contacts canonically as
 * +91XXXXXXXXXX (migration 089), so the conversion happens HERE, at the
 * provider edge, rather than by storing a provider-shaped value.
 *
 * Anything that is not a recognisable Indian number is passed through
 * untouched — this is a formatter, not a validator, and swallowing an
 * unexpected value would hide it instead of letting the payload check fail.
 */
function providerPhone(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const digits = raw.replace(/[^0-9]+/g, '');
  if (/^91[0-9]{10}$/.test(digits)) return digits.slice(2);
  if (/^0[0-9]{10}$/.test(digits)) return digits.slice(1);
  if (/^[0-9]{10}$/.test(digits)) return digits;
  return raw;
}

function minorToRupeeString(minor) {
  const n = Number(minor);
  if (!Number.isFinite(n) || n <= 0) return '';
  return (n / 100).toFixed(2);
}
function mmToCmString(mm) {
  const n = Number(mm);
  if (!Number.isFinite(n) || n <= 0) return '';
  return String(Math.round(n / 10));
}
function firstString(node, keys) {
  if (!node) return null;
  for (const k of keys) {
    const v = node[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}
