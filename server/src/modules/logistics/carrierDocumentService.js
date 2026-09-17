import { randomUUID, createHash } from 'node:crypto';
import { env } from '../../config/index.js';
import { AppError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { query } from '../../database/connection/pool.js';
import { orderOpsRepository } from '../orderOps/repository.js';
import { shippingService } from '../shipping/service.js';
import { documentStorage } from '../documents/storage.js';

const log = logger('carrier-documents');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// Phase 2 · Slice 17 — carrier-provided shipment documents (EPOD / QC image /
// Sorter image / signature). Two sources land in `shipment_provider_documents`:
//
//   * the three Document Push webhooks (documentApplier.js) — base64 or a URL
//   * the Download Document API (`orchestrator.getDocuments`) — a URL
//
// The row is idempotent on (provider_code, provider_event_key). A base64 push
// is copied into private document storage (`documents/storage.js`); a URL is
// linked as-is (same class as the shipping-label S3 URL). The AWB is the
// trusted link key — the provider's order ref is recorded but only advisory
// (QC `returnId` semantics are ambiguous per the requirement template).

const CONTENT_TYPE_BY_MAGIC = [
  { sig: [0x89, 0x50, 0x4e, 0x47], type: 'image/png', ext: 'png' },
  { sig: [0xff, 0xd8, 0xff], type: 'image/jpeg', ext: 'jpg' },
  { sig: [0x25, 0x50, 0x44, 0x46], type: 'application/pdf', ext: 'pdf' },
];

function sniff(buffer) {
  for (const c of CONTENT_TYPE_BY_MAGIC) {
    if (c.sig.every((b, i) => buffer[i] === b)) return c;
  }
  return null;
}

function decodeBase64Image(value) {
  const cleaned = String(value).replace(/^data:[^;,]*;base64,/i, '').replace(/\s+/g, '');
  let buffer;
  try { buffer = Buffer.from(cleaned, 'base64'); } catch { return null; }
  if (!buffer.length) return null;
  const kind = sniff(buffer);
  if (!kind) return null; // not an image/pdf we recognise — do not store mystery bytes
  return { buffer, ...kind };
}

export class CarrierDocumentService {
  constructor({
    repository = orderOpsRepository,
    orchestrator = shippingService.orchestrator,
    storage = documentStorage,
    db = query,
    maxBytes = Number(env.SHIPMENT_DOCUMENT_MAX_BYTES) || 10_485_760,
    now = () => new Date(),
  } = {}) {
    this.repository = repository;
    this.orchestrator = orchestrator;
    this.storage = storage;
    this.db = db;
    this.maxBytes = maxBytes;
    this.now = now;
  }

  #rowById(id) {
    return this.db('SELECT * FROM shipment_provider_documents WHERE id = ? LIMIT 1', [id]).then((r) => r[0] || null);
  }

  #existing(providerCode, providerEventKey) {
    return this.db(
      'SELECT * FROM shipment_provider_documents WHERE provider_code = ? AND provider_event_key = ? LIMIT 1',
      [providerCode, providerEventKey],
    ).then((r) => r[0] || null);
  }

  /**
   * Record a document that arrived on a Document Push webhook.
   * @returns {'APPLIED'|'IGNORED'} — APPLIED when a new row was created.
   */
  async recordFromWebhook({ providerCode, providerEventKey, docType, awb, providerOrderRef = null, attachment = null, imageUrl = null }) {
    if (!providerEventKey || !docType) return 'IGNORED';
    const existing = await this.#existing(providerCode, providerEventKey);
    if (existing) return 'IGNORED'; // replayed webhook — one row

    const shipment = awb ? await this.repository.shipmentByTrackingNumber(awb, providerCode) : null;
    let linkStatus = shipment ? 'LINKED' : 'UNMATCHED_AWB';
    if (shipment && providerOrderRef && shipment.order_number
      && String(providerOrderRef).trim() !== String(shipment.order_number).trim()) {
      linkStatus = 'REF_MISMATCH'; // still linked by AWB (the trusted key), just flagged
    }

    const disposition = await this.#imageDisposition({ attachment, imageUrl, docType, awb });

    const id = randomUUID();
    try {
      await this.db(
        `INSERT INTO shipment_provider_documents
          (id, shipment_id, order_id, provider_code, awb, doc_type, source, provider_event_key,
           image_status, image_url, storage_key, sha256, byte_size, content_type,
           provider_order_ref, link_status, received_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, 'WEBHOOK', ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), ?)`,
        [
          id, shipment?.id || null, shipment?.order_id || null, providerCode, awb || null, docType, providerEventKey,
          disposition.imageStatus, disposition.imageUrl, disposition.storageKey, disposition.sha256,
          disposition.byteSize, disposition.contentType,
          providerOrderRef ? String(providerOrderRef).slice(0, 160) : null, linkStatus,
          disposition.note ? JSON.stringify({ note: disposition.note }) : null,
        ],
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') return 'IGNORED';
      throw err;
    }
    log.info('carrier_document_recorded', { id, docType, awb, linkStatus, imageStatus: disposition.imageStatus, source: 'WEBHOOK' });
    return 'APPLIED';
  }

  async #imageDisposition({ attachment, imageUrl }) {
    const url = imageUrl || (attachment?.kind === 'URL' ? attachment.value : null);
    if (url) {
      return { imageStatus: 'LINKED_URL', imageUrl: String(url).slice(0, 1000), storageKey: null, sha256: null, byteSize: null, contentType: null, note: null };
    }
    if (attachment?.kind === 'BASE64') {
      const decoded = decodeBase64Image(attachment.value);
      if (!decoded) {
        return { imageStatus: 'PENDING_FETCH', imageUrl: null, storageKey: null, sha256: null, byteSize: null, contentType: null, note: 'push image not a recognised format' };
      }
      if (decoded.buffer.length > this.maxBytes) {
        return { imageStatus: 'PENDING_FETCH', imageUrl: null, storageKey: null, sha256: null, byteSize: decoded.buffer.length, contentType: decoded.type, note: 'push image over size cap' };
      }
      const key = this.storage.newKey(decoded.ext);
      try {
        const stored = await this.storage.put(key, decoded.buffer);
        return { imageStatus: 'STORED', imageUrl: null, storageKey: stored.key, sha256: stored.sha256, byteSize: stored.byteSize, contentType: decoded.type, note: null };
      } catch (err) {
        log.error('carrier_document_store_failed', { code: err?.code });
        return { imageStatus: 'PENDING_FETCH', imageUrl: null, storageKey: null, sha256: null, byteSize: null, contentType: null, note: 'storage failed' };
      }
    }
    return { imageStatus: 'PENDING_FETCH', imageUrl: null, storageKey: null, sha256: null, byteSize: null, contentType: null, note: null };
  }

  /**
   * Pull a proof document from the carrier (Download Document API). Resolves a
   * PENDING_FETCH webhook row in place, or records a new API_PULL row.
   */
  async fetchFromProvider({ shipmentId, docType }) {
    if (!['EPOD', 'QC_IMAGE', 'SIGNATURE'].includes(docType)) {
      throw new AppError('CARRIER_DOCUMENT_TYPE_INVALID', `Cannot pull "${docType}" from the carrier.`, 400);
    }
    const shipment = await this.repository.shipment(shipmentId);
    if (!shipment) throw new AppError('SHIPMENT_NOT_FOUND', 'Shipment not found.', 404);
    if (!shipment.tracking_number) throw new AppError('SHIPMENT_NOT_BOOKED', 'This shipment has no AWB yet.', 409);
    const providerCode = shipment.provider_code || 'DELHIVERY';

    let result;
    try {
      result = await this.orchestrator.getDocuments({ awb: shipment.tracking_number, docType, providerCode });
    } catch (error) {
      throw new AppError('CARRIER_DOCUMENT_FETCH_FAILED', 'The carrier document could not be retrieved.', 502, { providerReason: error?.message || null });
    }

    const pendingKey = `API:${docType}:${shipment.tracking_number}`;
    const openRow = await this.db(
      `SELECT * FROM shipment_provider_documents
        WHERE provider_code = ? AND doc_type = ? AND (shipment_id = ? OR awb = ?)
        ORDER BY received_at DESC LIMIT 1`,
      [providerCode, docType, shipmentId, shipment.tracking_number],
    ).then((r) => r[0] || null);

    if (!result.available || !result.url) {
      if (openRow && openRow.image_status === 'PENDING_FETCH') {
        await this.db(
          "UPDATE shipment_provider_documents SET image_status = 'UNAVAILABLE', fetched_at = NOW(3) WHERE id = ?",
          [openRow.id],
        );
      }
      return { available: false, docType };
    }

    const url = String(result.url).slice(0, 1000);
    if (openRow) {
      await this.db(
        `UPDATE shipment_provider_documents
            SET image_status = 'LINKED_URL', image_url = ?, source = source, fetched_at = NOW(3),
                shipment_id = COALESCE(shipment_id, ?), order_id = COALESCE(order_id, ?)
          WHERE id = ?`,
        [url, shipmentId, shipment.order_id ?? null, openRow.id],
      );
      return { available: true, docType, id: openRow.id, imageStatus: 'LINKED_URL', url };
    }
    const id = randomUUID();
    await this.db(
      `INSERT INTO shipment_provider_documents
        (id, shipment_id, order_id, provider_code, awb, doc_type, source, provider_event_key,
         image_status, image_url, link_status, received_at, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, 'API_PULL', ?, 'LINKED_URL', ?, 'LINKED', NOW(3), NOW(3))`,
      [id, shipmentId, shipment.order_id ?? null, providerCode, shipment.tracking_number, docType, pendingKey, url],
    ).catch(async (err) => {
      if (err.code !== 'ER_DUP_ENTRY') throw err;
      await this.db("UPDATE shipment_provider_documents SET image_status='LINKED_URL', image_url=?, fetched_at=NOW(3) WHERE provider_code=? AND provider_event_key=?", [url, providerCode, pendingKey]);
    });
    return { available: true, docType, id, imageStatus: 'LINKED_URL', url };
  }

  async listForShipment(shipmentId) {
    const rows = await this.db(
      'SELECT * FROM shipment_provider_documents WHERE shipment_id = ? ORDER BY received_at DESC',
      [shipmentId],
    );
    return rows.map((r) => this.#toDto(r));
  }

  async listForOrder(orderId) {
    const rows = await this.db(
      'SELECT * FROM shipment_provider_documents WHERE order_id = ? ORDER BY received_at DESC',
      [orderId],
    );
    return rows.map((r) => this.#toDto(r));
  }

  #toDto(r) {
    return {
      id: r.id,
      shipmentId: r.shipment_id,
      docType: r.doc_type,
      source: r.source,
      awb: r.awb,
      imageStatus: r.image_status,
      // A STORED image streams from our API; a LINKED_URL points at the carrier.
      url: r.image_status === 'LINKED_URL' ? r.image_url : null,
      contentPath: r.image_status === 'STORED' ? `/api/v1/admin/carrier-documents/${r.id}/content` : null,
      byteSize: r.byte_size == null ? null : Number(r.byte_size),
      contentType: r.content_type,
      linkStatus: r.link_status,
      providerOrderRef: r.provider_order_ref,
      receivedAt: r.received_at,
      fetchedAt: r.fetched_at,
    };
  }

  /** Bytes for a STORED document (integrity-checked), or a redirect for a URL. */
  async content(id) {
    const row = await this.#rowById(id);
    if (!row) throw new AppError('CARRIER_DOCUMENT_NOT_FOUND', 'Document not found.', 404);
    if (row.image_status === 'LINKED_URL' && row.image_url) return { redirect: row.image_url };
    if (row.image_status !== 'STORED' || !row.storage_key) {
      throw new AppError('CARRIER_DOCUMENT_NOT_READY', 'This document has no stored content.', 409);
    }
    const bytes = await this.storage.get(row.storage_key);
    if (sha256(bytes) !== row.sha256) {
      throw new AppError('CARRIER_DOCUMENT_INTEGRITY_FAILED', 'The stored document failed its integrity check.', 502);
    }
    return {
      bytes,
      contentType: row.content_type || 'application/octet-stream',
      filename: `${row.doc_type.toLowerCase()}-${id}.${row.storage_key.split('.').pop()}`,
    };
  }
}

export const carrierDocumentService = new CarrierDocumentService();
