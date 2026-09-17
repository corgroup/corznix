import { env } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { carrierDocumentService } from './carrierDocumentService.js';

const log = logger('carrier-document-applier');

// Phase 2 · Slice 17 — the domain applier for the three Delhivery Document Push
// capabilities (logistics-epod / logistics-qc / logistics-sorter). Registered
// by logistics/bootstrap.js.
//
// Receives the normalized event (identifiers + `imageUrl` in `summary`) plus
// the transient `attachment` (the base64 / URL blob, forwarded in memory only —
// never on the inbox row). Delegates to carrierDocumentService which links the
// document to its shipment by AWB and persists the image.
export async function carrierDocumentApplier(event) {
  const summary = event?.summary ?? {};
  const providerCode = event.providerKey === 'MOCK' ? 'MOCK' : 'DELHIVERY';
  const { docType, awb, orderRef, imageUrl } = summary;

  if (!docType || !event.providerEventId) {
    log.warn('document_missing_keys', { correlationId: event.correlationId });
    return 'IGNORED';
  }

  // OBSERVE mode mirrors the Scan Push applier: verified + stored on the inbox,
  // nothing else touched.
  if (env.LOGISTICS_WEBHOOK_APPLY === 'OBSERVE') {
    log.info('document_observed_not_applied', { docType, awb, correlationId: event.correlationId });
    return 'IGNORED';
  }

  return carrierDocumentService.recordFromWebhook({
    providerCode,
    providerEventKey: event.providerEventId,
    docType,
    awb: awb || null,
    providerOrderRef: orderRef || null,
    attachment: event.attachment || null,
    imageUrl: imageUrl || null,
  });
}
