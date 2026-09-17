import { createHash } from 'node:crypto';
import { AppError } from '../../utils/errors.js';
import { reconciliationRepository as X } from './reconciliationRepository.js';
import { reportingRepository as R } from './reportingRepository.js';
import { parsePagination, parseEnum } from './guards.js';

const STATES = ['OPEN', 'ACKNOWLEDGED', 'MANUAL_REVIEW', 'RESOLVED', 'REOPENED'];
const TYPES = [
  'COD_SPLIT_MISMATCH', 'CREDIT_NOTE_DUPLICATE', 'STORE_CREDIT_LEDGER_DRIFT',
  'REFUND_UNKNOWN', 'PAYMENT_UNKNOWN', 'SETTLEMENT_UNMATCHED', 'SETTLEMENT_AMOUNT_MISMATCH',
  'INVENTORY_RESERVED_DRIFT',
];
const n = (v) => Number(v || 0);

/**
 * Wave 8H reconciliation. Compares CORCOTTON's own financial truth with itself
 * and with imported provider evidence, and raises exceptions — it NEVER mutates
 * a source record (§85). Named resolution actions only (§91).
 */
export class ReconciliationService {
  /**
   * Re-scan internal invariants for ONE company. Idempotent: same discrepancy
   * → same exception row.
   *
   * The invariant READS below are brand-scoped. The exception rows they raise
   * are not yet: reconciliation_exceptions has no brand_id column, so an
   * exception cannot be attributed to a company or filtered per company in the
   * CMS. Closing that needs a migration plus a dedupeKey change — tracked
   * separately; scoping the reads first stops the scan itself from reading
   * across companies.
   */
  async runScan(brandId) {
    const raised = { COD_SPLIT_MISMATCH: 0, CREDIT_NOTE_DUPLICATE: 0, STORE_CREDIT_LEDGER_DRIFT: 0, REFUND_UNKNOWN: 0, PAYMENT_UNKNOWN: 0, INVENTORY_RESERVED_DRIFT: 0 };

    for (const m of await R.codSplitMismatches(brandId)) {
      await X.upsertException({ brandId,
        exceptionType: 'COD_SPLIT_MISMATCH', sourceDomain: 'cod', referenceType: 'order', referenceId: m.order_id,
        expectedMinor: n(m.cod_due_minor), actualMinor: n(m.allocated_minor),
        detail: { orderNumber: m.order_number }, dedupeKey: `COD_SPLIT_MISMATCH:${m.order_id}`,
      });
      raised.COD_SPLIT_MISMATCH += 1;
    }
    for (const d of await R.creditNoteDuplicates(brandId)) {
      await X.upsertException({ brandId,
        exceptionType: 'CREDIT_NOTE_DUPLICATE', sourceDomain: 'credit_note', referenceType: 'return_request', referenceId: d.return_request_id,
        expectedMinor: 1, actualMinor: n(d.n), detail: { count: n(d.n) }, dedupeKey: `CREDIT_NOTE_DUPLICATE:${d.return_request_id}`,
      });
      raised.CREDIT_NOTE_DUPLICATE += 1;
    }
    for (const a of await R.storeCreditLedgerDrift(brandId)) {
      await X.upsertException({ brandId,
        exceptionType: 'STORE_CREDIT_LEDGER_DRIFT', sourceDomain: 'store_credit', referenceType: 'store_credit_account', referenceId: a.account_id,
        expectedMinor: n(a.ledger_sum), actualMinor: n(a.balance_minor),
        detail: { lastBalanceAfterMinor: n(a.last_balance_after) }, dedupeKey: `STORE_CREDIT_LEDGER_DRIFT:${a.account_id}`,
      });
      raised.STORE_CREDIT_LEDGER_DRIFT += 1;
    }
    for (const r of await R.refundUnknown(brandId)) {
      await X.upsertException({ brandId,
        exceptionType: 'REFUND_UNKNOWN', sourceDomain: 'refund', referenceType: 'refund', referenceId: r.refund_number,
        expectedMinor: n(r.amount_minor), actualMinor: null,
        detail: { provider: r.provider_code, orderId: r.order_id }, dedupeKey: `REFUND_UNKNOWN:${r.refund_number}`,
      });
      raised.REFUND_UNKNOWN += 1;
    }
    for (const p of await R.paymentUnknown(brandId)) {
      await X.upsertException({ brandId,
        exceptionType: 'PAYMENT_UNKNOWN', sourceDomain: 'payment', referenceType: 'payment_attempt', referenceId: p.id,
        expectedMinor: n(p.amount_minor), actualMinor: null,
        detail: { provider: p.provider_code, merchantReference: p.merchant_reference }, dedupeKey: `PAYMENT_UNKNOWN:${p.id}`,
      });
      raised.PAYMENT_UNKNOWN += 1;
    }
    // WP-12 — inventory.reserved must equal the summed quantity of every
    // RESERVED reservation line for that (warehouse, sku). A drift here means
    // a reservation transition (or a movement) did not carry its balance
    // change; the operations team resolves it from the reconciliation queue,
    // this never mutates inventory (§85).
    for (const d of await R.inventoryReservedDrift(brandId)) {
      await X.upsertException({ brandId,
        exceptionType: 'INVENTORY_RESERVED_DRIFT', sourceDomain: 'inventory',
        referenceType: 'inventory', referenceId: `${d.warehouse_id}:${d.sku_id}`,
        expectedMinor: n(d.reserved_from_reservations), actualMinor: n(d.reserved),
        detail: { warehouseId: d.warehouse_id, skuId: d.sku_id, sku: d.sku, onHand: n(d.on_hand) },
        dedupeKey: `INVENTORY_RESERVED_DRIFT:${d.warehouse_id}:${d.sku_id}`,
      });
      raised.INVENTORY_RESERVED_DRIFT += 1;
    }
    return { scannedAt: new Date(), raised };
  }

  async list(q, brandId) {
    const { offset, pageSize, page } = parsePagination(q);
    const status = parseEnum(q.status, 'status', STATES);
    const type = parseEnum(q.type, 'type', TYPES);
    const [rows, total] = await Promise.all([X.list({ status, type, offset, limit: pageSize, brandId }), X.count({ status, type, brandId })]);
    return {
      pagination: { page, pageSize, total },
      exceptions: rows.map((r) => ({
        id: r.id, type: r.exception_type, sourceDomain: r.source_domain,
        referenceType: r.reference_type, referenceId: r.reference_id,
        expectedMinor: r.expected_minor == null ? null : Number(r.expected_minor),
        actualMinor: r.actual_minor == null ? null : Number(r.actual_minor),
        varianceMinor: r.expected_minor != null && r.actual_minor != null ? Number(r.actual_minor) - Number(r.expected_minor) : null,
        status: r.status, assignedEmail: r.assigned_email ?? null, resolutionNote: r.resolution_note ?? null,
        firstDetectedAt: r.first_detected_at, lastDetectedAt: r.last_detected_at, resolvedAt: r.resolved_at ?? null,
      })),
    };
  }

  async detail(id, brandId) {
    const e = await X.byId(id, brandId);
    if (!e) throw new AppError('RECONCILIATION_EXCEPTION_NOT_FOUND', 'Exception not found.', 404);
    return { ...(await this.list({ status: null }, brandId)).exceptions.find((x) => x.id === id) || {}, events: await X.events(id, brandId) };
  }

  // Named actions only. NONE of them corrects the source domain — that must go
  // through the owning domain's own validated workflow (§85/§91).
  async act({ id, action, note, staffId, brandId }) {
    const MAP = {
      ACKNOWLEDGE: { toStatus: 'ACKNOWLEDGED', eventType: 'ACKNOWLEDGED', assign: true },
      MANUAL_REVIEW: { toStatus: 'MANUAL_REVIEW', eventType: 'FLAGGED_MANUAL_REVIEW', assign: true },
      RESOLVE: { toStatus: 'RESOLVED', eventType: 'RESOLVED_WITH_EVIDENCE', requireNote: true },
      REOPEN: { toStatus: 'REOPENED', eventType: 'REOPENED' },
    };
    const spec = MAP[action];
    if (!spec) throw new AppError('VALIDATION_ERROR', `action must be one of: ${Object.keys(MAP).join(', ')}`, 400);
    if (spec.requireNote && (!note || note.trim().length < 3)) {
      throw new AppError('VALIDATION_ERROR', 'RESOLVE requires an evidence note.', 400);
    }
    const updated = await X.transition(id, {
      toStatus: spec.toStatus, eventType: spec.eventType, note: note ?? null, staffId,
      assignStaffId: spec.assign ? staffId : null, brandId,
    });
    if (!updated) throw new AppError('RECONCILIATION_EXCEPTION_NOT_FOUND', 'Exception not found.', 404);
    return { id, status: updated.status };
  }

  /**
   * Import a provider settlement CSV (payment/refund/COD). No live settlement
   * API is integrated — this is the seam. Re-importing the same file is a
   * no-op (file_hash unique). Rows: `reference,amount_minor,status`.
   */
  async importSettlement({ providerCode, kind, fileName, csvText, staffId, brandId }) {
    if (!['PAYMENT', 'REFUND', 'COD'].includes(kind)) throw new AppError('VALIDATION_ERROR', 'kind must be PAYMENT, REFUND or COD.', 400);
    if (!csvText || csvText.length > 2_000_000) throw new AppError('VALIDATION_ERROR', 'CSV missing or too large.', 400);
    const fileHash = createHash('sha256').update(`${providerCode}|${kind}|${csvText}`).digest('hex');
    const existing = await X.settlementImportByHash(fileHash, brandId);
    if (existing) {
      return { importId: existing.id, provider: existing.provider_code, kind: existing.kind, rowCount: existing.row_count, matchedCount: existing.matched_count, exceptionCount: existing.exception_count, deduped: true };
    }

    const lines = csvText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const header = (lines.shift() || '').toLowerCase().split(',').map((s) => s.trim());
    if (header[0] !== 'reference' || header[1] !== 'amount_minor' || header[2] !== 'status') {
      throw new AppError('VALIDATION_ERROR', 'CSV header must be: reference,amount_minor,status', 400);
    }
    let matched = 0;
    let exceptions = 0;
    for (const line of lines) {
      const [reference, amountRaw, statusRaw] = line.split(',').map((s) => s.trim());
      const amount = Number(amountRaw);
      if (!reference || !Number.isInteger(amount) || amount < 0) throw new AppError('VALIDATION_ERROR', `bad settlement row: ${line.slice(0, 60)}`, 400);
      const internal = kind === 'REFUND' ? await X.matchRefund(reference, brandId) : await X.matchPayment(reference, brandId);
      if (!internal) {
        await X.upsertException({ brandId,
          exceptionType: 'SETTLEMENT_UNMATCHED', sourceDomain: kind.toLowerCase(), referenceType: 'settlement_row', referenceId: `${providerCode}:${reference}`,
          expectedMinor: null, actualMinor: amount, detail: { providerStatus: statusRaw }, dedupeKey: `SETTLEMENT_UNMATCHED:${fileHash.slice(0, 12)}:${reference}`,
        });
        exceptions += 1;
      } else if (Number(internal.amount_minor) !== amount) {
        await X.upsertException({ brandId,
          exceptionType: 'SETTLEMENT_AMOUNT_MISMATCH', sourceDomain: kind.toLowerCase(), referenceType: 'settlement_row', referenceId: `${providerCode}:${reference}`,
          expectedMinor: Number(internal.amount_minor), actualMinor: amount, detail: { internalStatus: internal.status, providerStatus: statusRaw }, dedupeKey: `SETTLEMENT_AMOUNT_MISMATCH:${fileHash.slice(0, 12)}:${reference}`,
        });
        exceptions += 1;
      } else {
        matched += 1;
      }
    }
    const importId = await X.insertSettlementImport({
      brandId, providerCode, kind, fileName: fileName || 'settlement.csv', fileHash, rowCount: lines.length, matchedCount: matched, exceptionCount: exceptions, staffId,
    });
    return { importId, provider: providerCode, kind, rowCount: lines.length, matchedCount: matched, exceptionCount: exceptions, deduped: false };
  }
}

export const reconciliationService = new ReconciliationService();
export const RECONCILIATION_TYPES = TYPES;
