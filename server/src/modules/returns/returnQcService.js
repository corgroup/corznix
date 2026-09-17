import { randomUUID, createHash } from 'node:crypto';
import { AppError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { query } from '../../database/connection/pool.js';
import { withTransaction } from '../../database/connection/transaction.js';
import { returnsRepository } from './repository.js';

const log = logger('return-qc');
const parse = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);
const sha256 = (v) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');

// Phase 2 · Slice 19 — RVP QC 3.0 foundation.
//
// Delhivery RVP QC: the pickup agent runs a CORCOTTON-defined question set
// (`custom_qc` block on the reverse-shipment create payload). A wrong answer to
// a REQUIRED question fails QC. CORCOTTON owns stable question IDs
// (`CORCOTTON_QC_NNN`) with a controlled mapping to Delhivery's account IDs.
//
// Foundation scope:
//   * question registry (qc_questions) + applicability by return reason
//   * `custom_qc` builder with HARD limit validation (<=2 items, <=6 questions
//     per item) — invalid config -> explicit error + MANUAL_REVIEW, never a
//     silent downgrade
//   * a frozen, versioned snapshot per return request (a later template edit
//     never alters history)
//   * FE-QC-result evaluation (required vs informational; damaged-return rule
//     lives in each question's reason-aware `correct_value`)
//
// Deferred (external): the real Delhivery reverse-create field spec, and the
// account-side question mappings (a question that is not MAPPED -> MANUAL_REVIEW).

export const QC_MAX_ITEMS = 2;
export const QC_MAX_QUESTIONS_PER_ITEM = 6;
// CORCOTTON is a single-category (apparel) brand today; the per-category
// applicability mechanism exists but resolves to this until a real catalog
// category join is wired.
const DEFAULT_PRODUCT_CATEGORY = 'apparel';

const listContains = (list, value) => Array.isArray(list) && list.map(String).includes(String(value));

/**
 * Pure — evaluate FE answers against a frozen custom_qc payload.
 * @param {Array} customQc  the frozen `custom_qc` array
 * @param {Array<{questionId:string, value:string[]}>} answers
 * @returns {{status:'PASS'|'FAIL'|'INCONCLUSIVE', failures:Array}}
 */
export function evaluateQcResult(customQc, answers) {
  // Answers may be keyed by the Delhivery id (real FE result) or the CORCOTTON
  // client id (our own records / the mock) — match on either.
  const byId = new Map();
  for (const a of answers || []) {
    byId.set(String(a.questionId), Array.isArray(a.value) ? a.value.map(String) : [String(a.value)]);
  }
  const failures = [];
  let inconclusive = false;

  for (const item of Array.isArray(customQc) ? customQc : []) {
    for (const q of Array.isArray(item.questions) ? item.questions : []) {
      if (!q.required) continue; // informational answers never fail QC (§T.2)
      const expected = Array.isArray(q.correct_value) ? q.correct_value.map(String) : null;
      if (!expected || !expected.length) continue; // required but no rubric -> cannot auto-judge
      const got = byId.get(String(q.questions_id)) ?? byId.get(String(q.client_question_id));
      if (!got || !got.length) { inconclusive = true; continue; }
      const ok = expected.length === got.length && expected.every((v) => got.includes(v));
      if (!ok) failures.push({ questionId: q.client_question_id || q.questions_id, expected, got, item: item.item });
    }
  }
  if (failures.length) return { status: 'FAIL', failures };
  if (inconclusive) return { status: 'INCONCLUSIVE', failures: [] };
  return { status: 'PASS', failures: [] };
}

export class ReturnQcService {
  constructor({ repository = returnsRepository, db = query, transaction = withTransaction, now = () => new Date() } = {}) {
    this.repository = repository;
    this.db = db;
    this.transaction = transaction;
    this.now = now;
  }

  // ---- question registry -------------------------------------------
  activeQuestions() {
    return this.db("SELECT * FROM qc_questions WHERE active = 1 ORDER BY sort_order, client_question_id").then((rows) => rows.map(hydrateQuestion));
  }

  listQuestions() {
    return this.db('SELECT * FROM qc_questions ORDER BY sort_order, client_question_id').then((rows) => rows.map(hydrateQuestion));
  }

  /** The Delhivery POC enters the account-mapped id here; bumps the version. */
  async updateQuestionMapping(clientQuestionId, { delhiveryMappingStatus, delhiveryQuestionId = null }) {
    if (!['PENDING', 'MAPPED', 'REJECTED'].includes(delhiveryMappingStatus)) {
      throw new AppError('QC_MAPPING_STATUS_INVALID', 'delhiveryMappingStatus must be PENDING, MAPPED or REJECTED.', 400);
    }
    if (delhiveryMappingStatus === 'MAPPED' && !delhiveryQuestionId) {
      throw new AppError('QC_MAPPING_ID_REQUIRED', 'A MAPPED question needs the Delhivery question id.', 400);
    }
    const res = await this.db(
      `UPDATE qc_questions SET delhivery_mapping_status = ?, delhivery_question_id = ?, version = version + 1
        WHERE client_question_id = ?`,
      [delhiveryMappingStatus, delhiveryQuestionId, clientQuestionId],
    );
    if (!res.affectedRows) throw new AppError('QC_QUESTION_NOT_FOUND', `No question ${clientQuestionId}.`, 404);
    return this.db('SELECT * FROM qc_questions WHERE client_question_id = ?', [clientQuestionId]).then((r) => hydrateQuestion(r[0]));
  }

  // ---- custom_qc builder ------------------------------------------
  #matches(q, { returnReason, productCategory }) {
    if (q.applicableReturnReasons && !listContains(q.applicableReturnReasons, returnReason)) return false;
    if (q.applicableProductCategories && !listContains(q.applicableProductCategories, productCategory)) return false;
    return true;
  }

  /**
   * Build the `custom_qc` payload for up to QC_MAX_ITEMS return items.
   * Throws a typed error (QC_ITEM_LIMIT_EXCEEDED / QC_QUESTION_LIMIT_EXCEEDED /
   * QC_MAPPING_INCOMPLETE / QC_NO_QUESTIONS) — the caller turns that into a
   * MANUAL_REVIEW snapshot.
   */
  async buildCustomQc(items) {
    if (!Array.isArray(items) || !items.length) {
      throw new AppError('QC_NO_ITEMS', 'No return items to build QC for.', 422);
    }
    if (items.length > QC_MAX_ITEMS) {
      throw new AppError('QC_ITEM_LIMIT_EXCEEDED', `RVP QC allows at most ${QC_MAX_ITEMS} items; this return has ${items.length}.`, 422);
    }
    const registry = await this.activeQuestions();
    const usedVersions = [];
    const questionIds = new Set();

    const customQc = items.map((it) => {
      const category = it.productCategory || DEFAULT_PRODUCT_CATEGORY;
      const applicable = registry.filter((q) => this.#matches(q, { returnReason: it.returnReason, productCategory: category }));
      if (!applicable.length) {
        throw new AppError('QC_NO_QUESTIONS', `No QC questions apply to reason ${it.returnReason || 'NONE'}.`, 422);
      }
      if (applicable.length > QC_MAX_QUESTIONS_PER_ITEM) {
        throw new AppError('QC_QUESTION_LIMIT_EXCEEDED', `${applicable.length} questions resolved for "${it.item}"; the limit is ${QC_MAX_QUESTIONS_PER_ITEM}.`, 422);
      }
      const unmapped = applicable.filter((q) => q.delhiveryMappingStatus !== 'MAPPED' || !q.delhiveryQuestionId);
      if (unmapped.length) {
        throw new AppError('QC_MAPPING_INCOMPLETE', `Delhivery mapping missing for: ${unmapped.map((q) => q.clientQuestionId).join(', ')}.`, 422);
      }
      for (const q of applicable) { questionIds.add(q.clientQuestionId); usedVersions.push(`${q.clientQuestionId}:${q.version}`); }

      return {
        item: it.item,
        description: it.description || null,
        images: Array.isArray(it.images) ? it.images : [],
        return_reason: it.returnReason || null,
        quantity: it.quantity || 1,
        brand: 'CORCOTTON',
        product_category: category,
        questions: applicable.map((q) => ({
          questions_id: q.delhiveryQuestionId,        // the Delhivery-side id goes on the wire
          client_question_id: q.clientQuestionId,     // kept for CORCOTTON's own records
          prompt: q.prompt,
          options: q.options || [],
          value: [],                                   // the FE fills this
          correct_value: q.correctValue || [],
          required: Boolean(q.required),
          type: q.answerType,
        })),
      };
    });

    const version = `v${sha256(usedVersions.sort().join('|')).slice(0, 12)}`;
    return { customQc, version, questionIds: [...questionIds] };
  }

  // ---- snapshot (freeze + result) --------------------------------
  async #itemsForRequest(returnRequestId) {
    return this.db(
      `SELECT rri.order_item_id, rri.sku_id, rri.quantity,
              COALESCE(rri.reason_code, rr.reason_code) AS reason_code,
              oi.product_name
         FROM return_request_items rri
         JOIN return_requests rr ON rr.id = rri.return_request_id
         JOIN order_items oi ON oi.id = rri.order_item_id
        WHERE rri.return_request_id = ?
        ORDER BY rri.created_at`,
      [returnRequestId],
    );
  }

  /** Freeze the QC config for a return request. Idempotent (1 per request). */
  async freezeForRequest({ returnRequestId, returnShipmentId = null, reverseAwb = null }) {
    const request = await this.repository.requestById(returnRequestId);
    if (!request) throw new AppError('RETURN_REQUEST_NOT_FOUND', 'Return request not found.', 404);

    const existing = await this.snapshotForRequest(request.id);
    if (existing) {
      // keep history immutable; only backfill the shipment/AWB link
      if ((returnShipmentId && !existing.returnShipmentId) || (reverseAwb && !existing.reverseAwb)) {
        await this.db(
          'UPDATE return_qc_snapshots SET return_shipment_id = COALESCE(return_shipment_id, ?), reverse_awb = COALESCE(reverse_awb, ?) WHERE id = ?',
          [returnShipmentId, reverseAwb, existing.id],
        );
        return this.snapshotForRequest(request.id);
      }
      return existing;
    }

    const rows = await this.#itemsForRequest(request.id);
    const items = rows.map((r) => ({
      item: r.product_name || 'CORCOTTON item',
      description: null,
      images: [],
      returnReason: r.reason_code || null,
      quantity: Number(r.quantity) || 1,
      productCategory: DEFAULT_PRODUCT_CATEGORY,
    }));

    let built;
    let buildStatus = 'BUILT';
    let buildError = null;
    try {
      built = await this.buildCustomQc(items);
    } catch (err) {
      buildStatus = 'MANUAL_REVIEW';
      buildError = `${err.code || 'QC_BUILD_FAILED'}: ${String(err.message || '').slice(0, 200)}`;
      built = { customQc: [], version: 'unbuilt', questionIds: [] };
      log.warn('qc_build_manual_review', { returnRequestId: request.id, code: err.code });
    }

    const id = randomUUID();
    try {
      await this.db(
        `INSERT INTO return_qc_snapshots
          (id, return_request_id, return_shipment_id, order_id, reverse_awb, qc_version,
           custom_qc_json, question_ids_json, build_status, build_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, request.id, returnShipmentId, request.order_id, reverseAwb, built.version,
          JSON.stringify(built.customQc), JSON.stringify(built.questionIds), buildStatus, buildError],
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') return this.snapshotForRequest(request.id);
      throw err;
    }
    log.info('qc_snapshot_frozen', { returnRequestId: request.id, buildStatus, version: built.version, questions: built.questionIds.length });
    return this.snapshotForRequest(request.id);
  }

  /** Record the FE (or manual) QC answers against the frozen snapshot. */
  async recordResult({ returnRequestId, answers, source = 'PROVIDER_FE' }) {
    const snap = await this.#rawSnapshot(returnRequestId);
    if (!snap) throw new AppError('QC_SNAPSHOT_NOT_FOUND', 'No QC snapshot for this return.', 404);
    if (snap.build_status !== 'BUILT') {
      throw new AppError('QC_SNAPSHOT_MANUAL_REVIEW', 'This QC config is in manual review — record QC manually on the return.', 409);
    }
    const evaluation = evaluateQcResult(parse(snap.custom_qc_json), answers);
    await this.db(
      `UPDATE return_qc_snapshots
          SET qc_status = ?, qc_result_json = ?, failure_details_json = ?, qc_source = ?, qc_recorded_at = NOW(3)
        WHERE id = ?`,
      [evaluation.status, JSON.stringify(answers || []), JSON.stringify(evaluation.failures), source, snap.id],
    );
    log.info('qc_result_recorded', { returnRequestId, status: evaluation.status, failures: evaluation.failures.length, source });
    return { ...evaluation, snapshotId: snap.id };
  }

  #rawSnapshot(returnRequestId) {
    return this.db(
      `SELECT s.* FROM return_qc_snapshots s
        JOIN return_requests r ON r.id = s.return_request_id
       WHERE s.return_request_id = ? OR r.request_number = ? LIMIT 1`,
      [returnRequestId, returnRequestId],
    ).then((r) => r[0] || null);
  }

  async snapshotForRequest(returnRequestId) {
    const s = await this.#rawSnapshot(returnRequestId);
    if (!s) return null;
    // Lazy evidence link — a QC image pushed for the reverse AWB (Slice 17).
    let evidence = null;
    if (s.reverse_awb) {
      evidence = await this.db(
        "SELECT id, image_status, image_url FROM shipment_provider_documents WHERE doc_type = 'QC_IMAGE' AND awb = ? ORDER BY received_at DESC LIMIT 1",
        [s.reverse_awb],
      ).then((r) => r[0] || null);
    }
    return {
      id: s.id,
      returnRequestId: s.return_request_id,
      returnShipmentId: s.return_shipment_id,
      reverseAwb: s.reverse_awb,
      qcVersion: s.qc_version,
      buildStatus: s.build_status,
      buildError: s.build_error,
      customQc: parse(s.custom_qc_json),
      questionIds: parse(s.question_ids_json),
      qcStatus: s.qc_status,
      qcResult: parse(s.qc_result_json),
      failureDetails: parse(s.failure_details_json),
      qcSource: s.qc_source,
      frozenAt: s.frozen_at,
      qcRecordedAt: s.qc_recorded_at,
      evidence: evidence
        ? { documentId: evidence.id, imageStatus: evidence.image_status, url: evidence.image_status === 'LINKED_URL' ? evidence.image_url : null }
        : null,
    };
  }
}

function hydrateQuestion(r) {
  if (!r) return null;
  return {
    id: r.id,
    clientQuestionId: r.client_question_id,
    prompt: r.prompt,
    answerType: r.answer_type,
    options: parse(r.options_json),
    correctValue: parse(r.correct_value_json),
    required: Boolean(r.required),
    applicableReturnReasons: parse(r.applicable_return_reasons_json),
    applicableProductCategories: parse(r.applicable_product_categories_json),
    delhiveryMappingStatus: r.delhivery_mapping_status,
    delhiveryQuestionId: r.delhivery_question_id,
    version: Number(r.version),
    active: Boolean(r.active),
    sortOrder: Number(r.sort_order),
    updatedAt: r.updated_at,
  };
}

export const returnQcService = new ReturnQcService();
