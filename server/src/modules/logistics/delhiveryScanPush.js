import { createHash } from 'node:crypto';
import { mapDelhiveryStatus } from './statusMap.js';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/**
 * The recommended Scan Push composite idempotency key (08d §M):
 *   AWB + StatusType + Status + StatusDateTime + NSLCode, hashed.
 *
 * Exported so the Slice 13 track-PULL reconciler produces the identical key for
 * the same carrier scan — a status already ingested from the webhook is then a
 * no-op when pulled from /api/v1/packages/json/, and vice versa.
 */
export function scanPushIdempotencyKey({ awb = null, statusType = null, statusText = null, statusDateTime = null, nslCode = null } = {}) {
  if (!awb && !statusDateTime) return null;
  return sha256([awb, statusType, statusText, statusDateTime, nslCode].map((v) => v ?? '').join('|'));
}

/**
 * Delhivery Scan Push v2.0 (27/02/2024) default payload, as documented in the
 * supplied source material (`08d` §K.1):
 *
 *   { "Shipment": {
 *       "Status": { "Status", "StatusDateTime", "StatusType", "StatusLocation", "Instructions" },
 *       "PickUpDate", "NSLCode", "Sortcode", "ReferenceNo", "AWB"
 *   } }
 *
 * Registered as the `logistics` webhook parser (both DELHIVERY and MOCK
 * providerKeys — the provider-neutral shape is identical). The unified
 * webhook inbox never stores the raw payload (§40/§47 of webhookInboxService),
 * so everything the domain applier will need to actually apply the event
 * — AWB, the mapped status, the occurrence time, location, remarks — must be
 * carried in `safeSummary`. None of this is secret: it is the same class of
 * operational tracking text CORCOTTON already stores in `shipment_events`.
 *
 * @param {object} payload
 * @returns {{providerEventId: string|null, normalizedEventType: string, resourceType: string, resourceId: string|null, safeSummary: object}}
 */
export function parseDelhiveryScanPush(payload) {
  const shipment = payload?.Shipment ?? {};
  const status = shipment?.Status ?? {};

  const awb = shipment?.AWB != null ? String(shipment.AWB).trim() : null;
  const statusType = status?.StatusType != null ? String(status.StatusType).trim() : null;
  const statusText = status?.Status != null ? String(status.Status).trim() : null;
  const statusDateTime = status?.StatusDateTime ?? null;
  const locationText = status?.StatusLocation != null ? String(status.StatusLocation).slice(0, 160) : null;
  const instructions = status?.Instructions != null ? String(status.Instructions).slice(0, 500) : null;
  const nslCode = shipment?.NSLCode != null ? String(shipment.NSLCode).trim() : null;
  const sortcode = shipment?.Sortcode != null ? String(shipment.Sortcode).trim() : null;
  const referenceNo = shipment?.ReferenceNo != null ? String(shipment.ReferenceNo).trim() : null;

  const mappedStatus = mapDelhiveryStatus({ statusType, statusText, instructions });

  // Composite idempotency key (08d §M) — shared with the Slice 13 track pull so
  // webhook and pull dedupe against each other.
  const providerEventId = scanPushIdempotencyKey({ awb, statusType, statusText, statusDateTime, nslCode });

  return {
    providerEventId,
    normalizedEventType: mappedStatus ?? 'UNMAPPED',
    resourceType: 'shipment',
    resourceId: awb,
    safeSummary: {
      awb,
      statusType,
      statusText,
      statusDateTime,
      locationText,
      instructions,
      nslCode,
      sortcode,
      referenceNo,
      mappedStatus,
    },
  };
}
