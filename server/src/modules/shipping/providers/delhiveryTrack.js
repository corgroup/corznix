// Phase 2 · Slice 13 — Delhivery Track (GET /api/v1/packages/json/) response
// parser. Kept out of the adapter so it is pure and unit-testable.
//
// Dev_API.docx documents the ENDPOINT (#9: `?waybill={csv}` OR `?ref_ids={id}`,
// "full scan history + current status") but NOT the response body shape. The
// ONLY Delhivery tracking body CORCOTTON has a documented contract for is the
// Scan Push webhook payload (08d §K.1 / 01-provider-contract-evidence.md):
//
//   { "Shipment": { "Status": { "Status", "StatusDateTime", "StatusType",
//       "StatusLocation", "Instructions" }, "NSLCode", "ReferenceNo", "AWB" } }
//
// The Track API is the source that Scan Push is derived from, so those field
// names are the strongest candidates. This parser looks for that shape across
// the plausible envelopes and FAILS LOUD (SHIPPING_PROVIDER_RESPONSE_INVALID)
// on a non-empty response it cannot read — it never fabricates a status. A
// genuinely empty envelope (no shipment for that waybill / ref) is a valid
// answer and returns `[]`, which is what the UNKNOWN-booking reconciler needs.

const firstString = (node, keys) => {
  if (!node || typeof node !== 'object') return null;
  for (const k of keys) {
    const v = node[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
};

// The per-shipment records, wherever the envelope hides them.
function shipmentNodes(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return null;
  if (Array.isArray(data.ShipmentData)) return data.ShipmentData;
  if (Array.isArray(data.shipment_data)) return data.shipment_data;
  if (Array.isArray(data.packages)) return data.packages;
  if (Array.isArray(data.data)) return data.data;
  if (data.Shipment || data.shipment) return [data];
  return null;
}

// Unwrap `{ Shipment: {...} }` / `{ shipment: {...} }` / bare.
const unwrap = (node) => (node && typeof node === 'object' ? (node.Shipment ?? node.shipment ?? node) : node);

function currentStatusOf(sh) {
  const st = sh.Status ?? sh.status ?? {};
  const statusText = firstString(st, ['Status', 'status', 'StatusText'])
    ?? firstString(sh, ['Status', 'status']);
  const statusType = firstString(st, ['StatusType', 'status_type', 'StatusTypeCode'])
    ?? firstString(sh, ['StatusType', 'status_type']);
  const statusDateTime = firstString(st, ['StatusDateTime', 'StatusDatetime', 'status_date_time', 'StatusTime'])
    ?? firstString(sh, ['StatusDateTime']);
  const locationText = firstString(st, ['StatusLocation', 'status_location', 'ScannedLocation'])
    ?? firstString(sh, ['StatusLocation']);
  const instructions = firstString(st, ['Instructions', 'Instruction', 'instructions'])
    ?? firstString(sh, ['Instructions']);
  const nslCode = firstString(st, ['StatusCode', 'NSLCode', 'NSL', 'nsl_code'])
    ?? firstString(sh, ['NSLCode', 'NSL']);
  return { statusText, statusType, statusDateTime, locationText, instructions, nslCode };
}

// Historical scans, when the record carries them. Element shape is undocumented;
// extract defensively and DROP (not fail) any element without a status + time —
// the current status is always authoritative, history is best-effort catch-up.
function historyOf(sh) {
  const raw = sh.Scans ?? sh.scans ?? sh.ScanDetail ?? sh.scan_detail ?? null;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const d = (item && typeof item === 'object' ? (item.ScanDetail ?? item.scan_detail ?? item) : null) || {};
    const statusText = firstString(d, ['Scan', 'ScanType', 'Status', 'scan', 'status']);
    const statusDateTime = firstString(d, ['ScanDateTime', 'StatusDateTime', 'scan_date_time', 'ScanDate']);
    if (!statusText || !statusDateTime) continue;
    out.push({
      statusText,
      statusType: firstString(d, ['StatusType', 'status_type']),
      statusDateTime,
      locationText: firstString(d, ['ScannedLocation', 'StatusLocation', 'scanned_location']),
      instructions: firstString(d, ['Instructions', 'Instruction', 'instructions']),
      nslCode: firstString(d, ['StatusCode', 'NSLCode', 'nsl_code']),
    });
  }
  return out;
}

/**
 * @param {any} data raw JSON body from GET /api/v1/packages/json/
 * @returns {Array<{
 *   awb: string|null, orderReference: string|null,
 *   current: {statusText,statusType,statusDateTime,locationText,instructions,nslCode},
 *   history: Array<object>
 * }>}
 * @throws Error('SHIPPING_PROVIDER_RESPONSE_INVALID') on a non-empty body that
 *         carries no readable shipment record.
 */
export function parseTrackResponse(data) {
  const nodes = shipmentNodes(data);
  if (nodes === null) throw new Error('SHIPPING_PROVIDER_RESPONSE_INVALID');
  if (nodes.length === 0) return []; // legitimately "no shipment for this identifier"

  const shipments = [];
  for (const node of nodes) {
    const sh = unwrap(node);
    if (!sh || typeof sh !== 'object') continue;
    const awb = firstString(sh, ['AWB', 'awb', 'Waybill', 'waybill', 'WaybillNo']);
    const orderReference = firstString(sh, ['ReferenceNo', 'reference_no', 'OrderId', 'order_id', 'ClientOrderId']);
    const current = currentStatusOf(sh);
    // A record with neither an AWB nor a current status is not something we can
    // act on — and if EVERY record is like that, the body is unreadable.
    if (!awb && !current.statusText) continue;
    shipments.push({ awb, orderReference, current, history: historyOf(sh) });
  }

  if (shipments.length === 0) throw new Error('SHIPPING_PROVIDER_RESPONSE_INVALID');
  return shipments;
}
