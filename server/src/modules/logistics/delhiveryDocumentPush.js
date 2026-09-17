import { createHash } from 'node:crypto';

const sha256 = (v) => createHash('sha256').update(v).digest('hex');

// Phase 2 · Slices 14/17 — parsers for the three Delhivery Document Push
// webhooks. These are SEPARATE webhook endpoints from Scan Push (Delhivery does
// not combine them).
//
// Default payloads (from the supplied requirement templates, v1.0 01-09-2022):
//   EPOD    : { "waybill", "EPOD": "<base64 image>", "orderID" }
//   QC Image: { "waybillId", "returnId": "<order id>", "Image": "<base64>" }
//   Sorter  : { "Waybill", "Weight_images": "<base64 / URL>", "doc" }
//
// `safeSummary` (persisted on the inbox row) carries identifiers + a bounded
// marker only — never the base64 blob. The blob, when present, is surfaced
// SEPARATELY as `attachment`: webhookInboxService forwards it to the domain
// applier but never writes it to the inbox row (§40/§47). The applier
// (logistics/documentApplier.js, Slice 17) copies the bytes into private
// document storage and links the document to its shipment by AWB.

function awbOf(payload) {
  const raw = payload?.waybill ?? payload?.waybillId ?? payload?.Waybill ?? payload?.AWB ?? null;
  return raw != null ? String(raw).trim() : null;
}

const isUrl = (v) => typeof v === 'string' && /^https?:\/\//i.test(v.trim());

function makeDocParser(docType, imageKey) {
  return function parse(payload) {
    const awb = awbOf(payload);
    const orderRef = payload?.orderID ?? payload?.returnId ?? payload?.doc ?? null;
    const rawImage = typeof payload?.[imageKey] === 'string' ? payload[imageKey].trim() : '';
    const hasImage = rawImage.length > 0;
    const kind = hasImage ? (isUrl(rawImage) ? 'URL' : 'BASE64') : null;

    // Idempotency key: docType + AWB + orderRef + a short fingerprint of the
    // image itself. A verbatim re-push dedupes; a genuinely different image for
    // the same shipment (e.g. a second QC photo) is a distinct event.
    const fingerprint = hasImage ? sha256(rawImage).slice(0, 16) : '';
    const providerEventId = awb || hasImage
      ? sha256([docType, awb ?? '', orderRef ?? '', fingerprint].join('|'))
      : null;

    return {
      providerEventId,
      normalizedEventType: `DOCUMENT_${docType}`,
      resourceType: 'shipment',
      resourceId: awb,
      safeSummary: {
        docType,
        awb,
        orderRef: orderRef != null ? String(orderRef).slice(0, 160) : null,
        imagePresent: hasImage,
        imageKind: kind,
        // A URL is a link, not a blob — safe to persist (same class as the
        // shipping-label S3 URL already stored on `shipments.label_url`).
        imageUrl: kind === 'URL' ? rawImage.slice(0, 1000) : null,
      },
      // Transient — forwarded to the applier, NEVER stored on the inbox row.
      attachment: hasImage ? { docType, awb, kind, value: rawImage } : null,
    };
  };
}

export const parseDelhiveryEpod = makeDocParser('EPOD', 'EPOD');
export const parseDelhiveryQcImage = makeDocParser('QC_IMAGE', 'Image');
export const parseDelhiverySorterImage = makeDocParser('SORTER_IMAGE', 'Weight_images');
