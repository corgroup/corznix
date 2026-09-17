// Phase 2 · Slice 18 — Delhivery NDR (Non-Delivery Report) action.
//
//   submit : POST /api/p/update   body { data: [{ waybill, act }] }
//            act ∈ RE-ATTEMPT | PICKUP_RESCHEDULE  (Dev_API.docx #16)
//            ASYNC — returns a UPL id.
//   status : GET  /api/cmu/get_bulk_upl/{UPL_ID}?verbose=true  (#17)
//
// The doc specs the request `act` values and the endpoints but NOT the
// response bodies. Both parsers look across the plausible fields and FAIL
// LOUD when a success response carries no id / no readable state — they never
// fabricate a UPL id or a resolution. Only `{ waybill, act }` is sent — an
// address / phone correction goes through editShipment (/api/p/edit), not
// here (no undocumented NDR fields).

export const DELHIVERY_NDR_ACT = Object.freeze({
  RE_ATTEMPT: 'RE-ATTEMPT',
  RESCHEDULE: 'PICKUP_RESCHEDULE',
});

const firstString = (node, keys) => {
  if (!node || typeof node !== 'object') return null;
  for (const k of keys) {
    const v = node[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
};

function firstRecord(data) {
  if (Array.isArray(data)) return data[0] && typeof data[0] === 'object' ? data[0] : {};
  if (data && typeof data === 'object') {
    if (Array.isArray(data.data)) return data.data[0] && typeof data.data[0] === 'object' ? data.data[0] : {};
    if (data.data && typeof data.data === 'object') return data.data;
    return data;
  }
  return {};
}

const safeRemark = (data) => firstString(data, ['error', 'errors', 'rmk', 'remark', 'remarks', 'message'])
  || firstString(firstRecord(data), ['error', 'rmk', 'remark', 'remarks', 'message']);

/**
 * @param {{awb: string, action: 'RE_ATTEMPT'|'RESCHEDULE'}} input
 * @returns {{data: Array<{waybill: string, act: string}>}}
 */
export function buildNdrUpdateBody({ awb, action }) {
  const act = DELHIVERY_NDR_ACT[action];
  if (!awb || !act) {
    const e = new Error('SHIPPING_PROVIDER_REQUEST_INVALID');
    e.code = 'SHIPPING_PROVIDER_REQUEST_INVALID';
    throw e;
  }
  return { data: [{ waybill: String(awb).trim(), act }] };
}

/**
 * @returns {{ ok: true, uplId: string } | { ok: false, code: string, remark: string|null }}
 */
export function parseNdrUpdateResponse(data) {
  if (data == null || typeof data !== 'object') return { ok: false, code: 'PROVIDER_RESPONSE_INVALID', remark: null };
  const uplId = firstString(data, ['upl', 'UPL', 'upl_id', 'UPL_ID', 'uplId', 'request_id', 'requestId', 'request_uuid', 'id'])
    || firstString(firstRecord(data), ['upl', 'UPL', 'upl_id', 'UPL_ID', 'request_id', 'id']);
  const failed = data.success === false || data.status === false || Boolean(firstString(data, ['error', 'errors']));
  if (uplId) return { ok: true, uplId };
  if (failed) return { ok: false, code: 'PROVIDER_REJECTED', remark: safeRemark(data) };
  return { ok: false, code: 'PROVIDER_RESPONSE_INVALID', remark: safeRemark(data) };
}

const norm = (v) => String(v ?? '').trim().toLowerCase();

/**
 * Classify the get_bulk_upl state for one waybill. Returns 'UNKNOWN' when the
 * body cannot be read with confidence — the caller keeps polling / surfaces it,
 * never assumes success.
 * @returns {{ state: 'PENDING'|'ACCEPTED'|'REJECTED'|'UNKNOWN', remark: string|null }}
 */
export function parseNdrStatusResponse(data, awb) {
  if (data == null || typeof data !== 'object') return { state: 'UNKNOWN', remark: null };

  // Hunt for a status/remark string near this waybill, then anywhere.
  const wb = String(awb ?? '').trim();
  const candidates = [];
  const visit = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 5) return;
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string') {
        if (/status|state|result|remark|reason|message|act/i.test(k)) candidates.push({ key: k, value: v, near: wb && node[wb] != null });
      } else if (v && typeof v === 'object') {
        visit(v, depth + 1);
      }
    }
  };
  visit(data);
  if (!candidates.length) return { state: 'UNKNOWN', remark: null };

  const text = candidates.map((c) => norm(c.value)).join(' | ');
  const remark = candidates.find((c) => /remark|reason|message/i.test(c.key))?.value
    || candidates[0].value;

  if (/(reject|fail|error|invalid|not\s*allow|expired|declin)/.test(text)) return { state: 'REJECTED', remark };
  if (/(success|complete|processed|accepted|done|updated|scheduled)/.test(text)) return { state: 'ACCEPTED', remark };
  if (/(pending|progress|queue|open|received|in\s*process|submitted)/.test(text)) return { state: 'PENDING', remark };
  return { state: 'UNKNOWN', remark };
}
