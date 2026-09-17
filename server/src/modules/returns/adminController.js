import { randomUUID } from 'node:crypto';
import { StaffAuditRepository } from '../staff/repositories.js';
import { returnsAdminService } from './adminService.js';
import { returnLifecycleService } from './returnLifecycleService.js';
import { refundService, transitionCodPayout } from './refundService.js';
import { refundPayoutService } from './refundPayoutService.js';
import { reverseShipmentService } from './reverseShipmentService.js';
import { returnQcService } from './returnQcService.js';
import { toCsv, sendCsv } from '../../utils/csv.js';
import { AppError } from '../../utils/errors.js';
import * as v from './validation.js';

const audit = new StaffAuditRepository();
const ok = (res, data, status = 200) => res.status(status).json({ data });

const logAudit = (req, action, requestId, metadata = null) => audit.log({
  staffUserId: req.staff.id, actorEmail: req.staff.email, action,
  resourceType: 'return_request', resourceId: requestId, metadata, ipAddress: req.ip,
});

export async function listReturns(req, res, next) {
  try {
    const filters = v.adminReturnsQuery.parse(req.query ?? {});
    ok(res, { returns: await returnsAdminService.list({ staff: req.staff, filters, brandId: req.brandId }) });
  } catch (err) { next(err); }
}

export async function getReturn(req, res, next) {
  try {
    ok(res, await returnsAdminService.detail({ staff: req.staff, requestId: req.params.id }));
  } catch (err) { next(err); }
}

export async function exportReturns(req, res, next) {
  try {
    const filters = v.adminReturnsQuery.parse(req.query ?? {});
    const rows = await returnsAdminService.list({ staff: req.staff, filters, brandId: req.brandId });
    const headers = ['Request', 'Type', 'Status', 'Order', 'Units', 'Reason', 'Reverse status', 'Refund method', 'Refund status', 'Requested', 'Updated'];
    sendCsv(res, 'returns', toCsv(headers, rows.map((r) => [
      r.requestNumber, r.requestType, r.status, r.orderNumber, r.unitCount, r.reasonCode || '',
      r.reverseStatus || '', r.refundMethod || '', r.refundStatus || '',
      r.requestedAt ? new Date(r.requestedAt).toISOString() : '',
      r.updatedAt ? new Date(r.updatedAt).toISOString() : '',
    ])));
  } catch (err) { next(err); }
}

const action = (name, run, auditAction) => async (req, res, next) => {
  try {
    await returnsAdminService.assertScope(req.staff, req.params.id);
    const result = await run(req);
    await logAudit(req, auditAction, req.params.id, { by: req.staff.email });
    ok(res, result);
    void name;
  } catch (err) { next(err); }
};

export const approveReturn = action('approve',
  (req) => returnLifecycleService.approve({ requestId: req.params.id, staffId: req.staff.id }), 'RETURN_APPROVED');

export const rejectReturn = action('reject',
  (req) => returnLifecycleService.reject({ requestId: req.params.id, staffId: req.staff.id, reason: req.body?.reason ?? null }), 'RETURN_REJECTED');

export const preparePickup = action('prepare-pickup',
  (req) => returnLifecycleService.preparePickup({ requestId: req.params.id, staffId: req.staff.id }), 'REVERSE_PICKUP_PREPARED');

export const bookPickup = action('book-pickup',
  (req) => returnLifecycleService.bookPickup({ requestId: req.params.id, staffId: req.staff.id, idempotencyKey: req.body?.idempotencyKey || `revbook:${req.params.id}:${randomUUID().slice(0, 8)}` }), 'REVERSE_PICKUP_BOOKED');

export const markReceived = action('mark-received',
  (req) => returnLifecycleService.markReceived({ requestId: req.params.id, staffId: req.staff.id }), 'RETURN_RECEIVED');

export const recordQc = action('qc',
  (req) => returnLifecycleService.recordQc({ requestId: req.params.id, staffId: req.staff.id, result: v.qcBody.parse(req.body ?? {}).result }),
  'RETURN_QC_RECORDED');

export const releaseReplacement = action('release-replacement',
  (req) => returnLifecycleService.replacements.releaseFor(req.params.id), 'REPLACEMENT_RELEASED');

export const completeReturn = action('complete',
  (req) => returnLifecycleService.completeResolution({ requestId: req.params.id, staffId: req.staff.id }), 'RETURN_COMPLETED');

// Financial — separate, higher-privilege gate (returns.refund, §109).
export const retryRefund = action('retry-refund',
  async (req) => {
    const body = v.retryRefundBody.parse(req.body ?? {});
    if (body.refundAttemptId) {
      return refundService.reconcile({ refundAttemptId: body.refundAttemptId, providerOutcome: body.providerOutcome });
    }
    return refundService.resolveForReturn({ returnRequestId: req.params.id });
  }, 'RETURN_REFUND_RETRIED');

// COD payouts are settled by a person, not a provider — the CMS records what
// they actually did in the bank/UPI portal. Same returns.refund gate as a retry.
export const settleCodPayout = action('settle-payout',
  async (req) => {
    const body = v.payoutTransitionBody.parse(req.body ?? {});
    return transitionCodPayout({ returnRequestId: req.params.id, staffId: req.staff?.id ?? null, ...body });
  }, 'RETURN_REFUND_PAYOUT_SETTLED');

// The full payout destination, for the operator actually moving the money.
// Highest gate (returns.refund) and audited on EVERY read: an account number
// leaving the database is an event worth being able to reconstruct later.
// Deliberately a POST so the value never lands in a URL, proxy log or browser
// history.
export const revealPayoutDestination = action('reveal-payout',
  async (req) => {
    const dest = await refundPayoutService.revealForPayout(req.params.id);
    if (!dest) throw new AppError('REFUND_PAYOUT_NOT_FOUND', 'No payout destination on file for this return.', 404);
    return { destination: dest };
  }, 'RETURN_REFUND_PAYOUT_REVEALED');

// Phase 2 · Slice 19 — RVP QC 3.0.
export async function getReturnQcSnapshot(req, res, next) {
  try {
    const snap = await returnQcService.snapshotForRequest(req.params.id);
    ok(res, { snapshot: snap });
  } catch (err) { next(err); }
}

export async function listQcQuestions(req, res, next) {
  try {
    ok(res, { questions: await returnQcService.listQuestions() });
  } catch (err) { next(err); }
}

export async function updateQcQuestionMapping(req, res, next) {
  try {
    const body = v.qcQuestionMappingBody.parse(req.body ?? {});
    const q = await returnQcService.updateQuestionMapping(req.params.clientQuestionId, {
      delhiveryMappingStatus: body.delhiveryMappingStatus, delhiveryQuestionId: body.delhiveryQuestionId ?? null,
    });
    await audit.log({
      staffUserId: req.staff.id, actorEmail: req.staff.email, action: 'QC_QUESTION_MAPPING_UPDATED',
      resourceType: 'qc_question', resourceId: req.params.clientQuestionId, metadata: { status: body.delhiveryMappingStatus }, ipAddress: req.ip,
    });
    ok(res, q);
  } catch (err) { next(err); }
}

export async function reconcileReverse(req, res, next) {
  try {
    const body = v.reconcileReverseBody.parse(req.body ?? {});
    const result = await reverseShipmentService.reconcile({ returnShipmentId: req.params.id, providerOutcome: body.providerOutcome });
    await audit.log({
      staffUserId: req.staff.id, actorEmail: req.staff.email, action: 'REVERSE_SHIPMENT_RECONCILED',
      resourceType: 'return_shipment', resourceId: req.params.id, ipAddress: req.ip,
    });
    ok(res, result);
  } catch (err) { next(err); }
}
