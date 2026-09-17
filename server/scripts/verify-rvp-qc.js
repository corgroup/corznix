// Phase 2 · Slice 19 — RVP QC 3.0 foundation.
//
// Mostly isolated: evaluateQcResult is pure; ReturnQcService runs with injected
// db / repository stubs. One real DB read confirms migration 066 + the seeded
// question set. NO real provider call.
//
//   * HARD limits: <=2 QC items, <=6 questions/item -> explicit error +
//     MANUAL_REVIEW snapshot, never a silent downgrade
//   * a question that is not MAPPED to a Delhivery id -> MANUAL_REVIEW
//   * required vs informational: an informational wrong answer never fails QC
//   * the frozen snapshot is immutable — re-freeze only backfills the AWB link
import assert from 'node:assert/strict';
import { ReturnQcService, evaluateQcResult, QC_MAX_ITEMS } from '../src/modules/returns/returnQcService.js';

const results = {};
const acheck = async (name, fn) => {
  try { const v = await fn(); results[name] = v === undefined ? 'PASS' : v; }
  catch (e) { results[name] = `FAIL ${e.message}`; }
  console.log(`  ${String(results[name]).startsWith('FAIL') ? 'FAIL' : 'PASS'}  ${name}`);
};

// ---- pure evaluation ------------------------------------------
const customQc = [{
  item: 'CORCOTTON Oversized T-Shirt',
  questions: [
    { questions_id: 'DL-1', client_question_id: 'CORCOTTON_QC_001', correct_value: ['Yes'], required: true, type: 'multi' },
    { questions_id: 'DL-2', client_question_id: 'CORCOTTON_QC_002', correct_value: ['Yes'], required: true, type: 'multi' },
    { questions_id: 'DL-6', client_question_id: 'CORCOTTON_QC_006', correct_value: [], required: false, type: 'text' },
  ],
}];

await acheck('evaluate_all_correct_is_pass', () => {
  const r = evaluateQcResult(customQc, [
    { questionId: 'CORCOTTON_QC_001', value: ['Yes'] },
    { questionId: 'CORCOTTON_QC_002', value: ['Yes'] },
  ]);
  assert.equal(r.status, 'PASS');
});

await acheck('evaluate_wrong_required_is_fail', () => {
  const r = evaluateQcResult(customQc, [
    { questionId: 'CORCOTTON_QC_001', value: ['Yes'] },
    { questionId: 'CORCOTTON_QC_002', value: ['No'] },
  ]);
  assert.equal(r.status, 'FAIL');
  assert.equal(r.failures[0].questionId, 'CORCOTTON_QC_002');
  assert.deepEqual(r.failures[0].got, ['No']);
});

await acheck('evaluate_missing_required_is_inconclusive', () => {
  const r = evaluateQcResult(customQc, [{ questionId: 'CORCOTTON_QC_001', value: ['Yes'] }]);
  assert.equal(r.status, 'INCONCLUSIVE');
});

await acheck('evaluate_informational_never_fails', () => {
  const r = evaluateQcResult(customQc, [
    { questionId: 'CORCOTTON_QC_001', value: ['Yes'] },
    { questionId: 'CORCOTTON_QC_002', value: ['Yes'] },
    { questionId: 'CORCOTTON_QC_006', value: ['some free text that is "wrong"'] },
  ]);
  assert.equal(r.status, 'PASS');
});

// ---- service (injected stubs) -------------------------------
const QUESTIONS = [
  { id: 'q1', client_question_id: 'CORCOTTON_QC_001', prompt: 'Same product?', answer_type: 'multi', options_json: '["Yes","No"]', correct_value_json: '["Yes"]', required: 1, applicable_return_reasons_json: null, applicable_product_categories_json: null, delhivery_mapping_status: 'PENDING', delhivery_question_id: null, version: 1, active: 1, sort_order: 10 },
  { id: 'q2', client_question_id: 'CORCOTTON_QC_002', prompt: 'Tags attached?', answer_type: 'multi', options_json: '["Yes","No"]', correct_value_json: '["Yes"]', required: 1, applicable_return_reasons_json: '["SIZE_FIT"]', applicable_product_categories_json: null, delhivery_mapping_status: 'PENDING', delhivery_question_id: null, version: 1, active: 1, sort_order: 20 },
  { id: 'q4', client_question_id: 'CORCOTTON_QC_004', prompt: 'Damage matches?', answer_type: 'multi', options_json: '["Yes","No"]', correct_value_json: '["Yes"]', required: 1, applicable_return_reasons_json: '["DEFECTIVE"]', applicable_product_categories_json: null, delhivery_mapping_status: 'PENDING', delhivery_question_id: null, version: 1, active: 1, sort_order: 40 },
];
const svc = ({ questions = QUESTIONS, request, items = [], capture = {} } = {}) => {
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const db = async (sql, params) => {
    const q = norm(sql);
    capture.sql = [...(capture.sql || []), q];
    if (/FROM qc_questions WHERE active = 1/.test(q)) return questions.filter((x) => x.active === 1);
    if (/^SELECT \* FROM qc_questions ORDER BY/.test(q)) return questions;
    if (/^UPDATE qc_questions SET/.test(q)) {
      const [, dqid, cid] = params;
      const row = questions.find((x) => x.client_question_id === cid);
      if (row) { row.delhivery_mapping_status = params[0]; row.delhivery_question_id = dqid; row.version += 1; }
      return { affectedRows: row ? 1 : 0 };
    }
    if (/FROM return_qc_snapshots/.test(q) && /return_request_id = \? OR r\.request_number/.test(q)) {
      return capture.snapshot ? [capture.snapshot] : [];
    }
    if (/FROM return_request_items rri/.test(q)) return items;
    if (/^INSERT INTO return_qc_snapshots/.test(q)) {
      capture.inserted = params;
      capture.snapshot = {
        id: params[0], return_request_id: params[1], return_shipment_id: params[2], order_id: params[3],
        reverse_awb: params[4], qc_version: params[5], custom_qc_json: params[6], question_ids_json: params[7],
        build_status: params[8], build_error: params[9], qc_status: 'NOT_RUN', qc_result_json: null,
        failure_details_json: null, qc_source: null, frozen_at: new Date(), qc_recorded_at: null,
      };
      return {};
    }
    if (/^UPDATE return_qc_snapshots/.test(q)) { capture.updated = [...(capture.updated || []), { q, params }]; return {}; }
    if (/FROM shipment_provider_documents WHERE doc_type = 'QC_IMAGE'/.test(q)) return [];
    return [];
  };
  return new ReturnQcService({
    repository: { async requestById() { return request; } },
    db,
    transaction: async (fn) => fn({}),
  });
};

await acheck('build_rejects_more_than_two_items', async () => {
  const s = svc();
  await assert.rejects(
    () => s.buildCustomQc([{ item: 'a', returnReason: 'SIZE_FIT' }, { item: 'b', returnReason: 'SIZE_FIT' }, { item: 'c', returnReason: 'SIZE_FIT' }]),
    (e) => e.code === 'QC_ITEM_LIMIT_EXCEEDED',
  );
  assert.equal(QC_MAX_ITEMS, 2);
});

await acheck('build_fails_when_mapping_incomplete', async () => {
  const s = svc();
  await assert.rejects(
    () => s.buildCustomQc([{ item: 'Tee', returnReason: 'SIZE_FIT' }]),
    (e) => e.code === 'QC_MAPPING_INCOMPLETE',
  );
});

await acheck('build_succeeds_after_mapping', async () => {
  const questions = JSON.parse(JSON.stringify(QUESTIONS));
  const s = svc({ questions });
  await s.updateQuestionMapping('CORCOTTON_QC_001', { delhiveryMappingStatus: 'MAPPED', delhiveryQuestionId: 'DLV_Q_1' });
  await s.updateQuestionMapping('CORCOTTON_QC_002', { delhiveryMappingStatus: 'MAPPED', delhiveryQuestionId: 'DLV_Q_2' });
  const built = await s.buildCustomQc([{ item: 'Tee', returnReason: 'SIZE_FIT', quantity: 1 }]);
  // SIZE_FIT -> QC_001 (all) + QC_002 (SIZE_FIT); NOT QC_004 (DEFECTIVE only)
  assert.deepEqual(built.questionIds.sort(), ['CORCOTTON_QC_001', 'CORCOTTON_QC_002']);
  assert.equal(built.customQc[0].questions[0].questions_id, 'DLV_Q_1'); // Delhivery id on the wire
  assert.equal(built.customQc[0].questions[0].value.length, 0);         // FE fills it
  assert.match(built.version, /^v[0-9a-f]{12}$/);
});

await acheck('reason_specific_question_selection', async () => {
  const questions = JSON.parse(JSON.stringify(QUESTIONS)).map((q) => ({ ...q, delhivery_mapping_status: 'MAPPED', delhivery_question_id: `DL_${q.client_question_id}` }));
  const s = svc({ questions });
  const defective = await s.buildCustomQc([{ item: 'Tee', returnReason: 'DEFECTIVE', quantity: 1 }]);
  assert.deepEqual(defective.questionIds.sort(), ['CORCOTTON_QC_001', 'CORCOTTON_QC_004']);
});

await acheck('freeze_manual_review_when_unmapped', async () => {
  const capture = {};
  const s = svc({
    request: { id: 'rr-1', order_id: 'ord-1', reason_code: 'SIZE_FIT' },
    items: [{ order_item_id: 'oi-1', sku_id: 'sk-1', quantity: 1, reason_code: 'SIZE_FIT', product_name: 'Oversized Tee' }],
    capture,
  });
  const snap = await s.freezeForRequest({ returnRequestId: 'rr-1' });
  assert.equal(snap.buildStatus, 'MANUAL_REVIEW');
  assert.match(snap.buildError, /QC_MAPPING_INCOMPLETE/);
  assert.deepEqual(snap.customQc, []);
});

await acheck('freeze_built_when_mapped_and_records_result', async () => {
  const questions = JSON.parse(JSON.stringify(QUESTIONS)).map((q) => ({ ...q, delhivery_mapping_status: 'MAPPED', delhivery_question_id: `DL_${q.client_question_id}` }));
  const capture = {};
  const s = svc({
    questions,
    request: { id: 'rr-2', order_id: 'ord-2', reason_code: 'SIZE_FIT' },
    items: [{ order_item_id: 'oi-1', sku_id: 'sk-1', quantity: 1, reason_code: 'SIZE_FIT', product_name: 'Oversized Tee' }],
    capture,
  });
  const snap = await s.freezeForRequest({ returnRequestId: 'rr-2' });
  assert.equal(snap.buildStatus, 'BUILT');
  assert.equal(snap.qcStatus, 'NOT_RUN');

  const pass = await s.recordResult({ returnRequestId: 'rr-2', answers: [
    { questionId: 'CORCOTTON_QC_001', value: ['Yes'] },
    { questionId: 'CORCOTTON_QC_002', value: ['Yes'] },
  ], source: 'MOCK' });
  assert.equal(pass.status, 'PASS');
  assert.ok(capture.updated.some((u) => /qc_status = \?/.test(u.q)));
});

await acheck('freeze_is_idempotent_backfills_awb_only', async () => {
  const questions = JSON.parse(JSON.stringify(QUESTIONS)).map((q) => ({ ...q, delhivery_mapping_status: 'MAPPED', delhivery_question_id: `DL_${q.client_question_id}` }));
  const capture = {};
  const s = svc({
    questions,
    request: { id: 'rr-3', order_id: 'ord-3', reason_code: 'SIZE_FIT' },
    items: [{ order_item_id: 'oi-1', sku_id: 'sk-1', quantity: 1, reason_code: 'SIZE_FIT', product_name: 'Tee' }],
    capture,
  });
  await s.freezeForRequest({ returnRequestId: 'rr-3' });
  const firstInsert = capture.inserted;
  await s.freezeForRequest({ returnRequestId: 'rr-3', reverseAwb: 'MOCKAWB-REV-1' });
  assert.equal(capture.inserted, firstInsert, 'no second INSERT'); // same object ref
  assert.ok(capture.updated.some((u) => /reverse_awb = COALESCE/.test(u.q)));
});

// ---- one real DB read: migration + seed --------------------
await acheck('migration_066_seed_loaded', async () => {
  const { pool } = await import('../src/database/connection/pool.js');
  try {
    const real = new ReturnQcService();
    const qs = await real.activeQuestions();
    assert.ok(qs.length >= 6, `expected the seeded question set, got ${qs.length}`);
    assert.ok(qs.every((q) => q.clientQuestionId.startsWith('CORCOTTON_QC_')));
    assert.ok(qs.every((q) => q.delhiveryMappingStatus === 'PENDING'), 'seed ships PENDING until the POC maps them');
  } finally {
    await pool.end();
  }
});

console.log('\n──── Phase 2 · Slice 19 — RVP QC foundation ────');
const failed = Object.entries(results).filter(([, v]) => String(v).startsWith('FAIL'));
console.log(`\nRVP_QC = ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length})`}`);
console.log('REAL_PROVIDER_CALLS = 0');
process.exitCode = failed.length === 0 ? 0 : 1;
