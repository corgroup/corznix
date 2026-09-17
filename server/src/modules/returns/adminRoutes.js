import { Router } from 'express';
import { requireStaffPermission } from '../../middleware/requireStaffPermission.js';
import { requireResourceBrand } from '../../middleware/requireResourceBrand.js';
import { PERMISSIONS } from '../staff/permissions.js';
import * as c from './adminController.js';

// CMS Returns & Exchanges area. Mounted under /api/v1/admin (staff session +
// cmsOriginGuard already applied). Warehouse scope is enforced inside the
// service (§110); money movement needs the separate returns.refund gate (§109).
const router = Router();

const read = requireStaffPermission(PERMISSIONS.RETURNS_READ);
const manage = requireStaffPermission(PERMISSIONS.RETURNS_MANAGE);
const refund = requireStaffPermission(PERMISSIONS.RETURNS_REFUND);

// Phase 6 security pass (DESIGN.md §5.3) — return_requests.brand_id (Phase 5)
// was never actually filtered on by any of these :id lookups; this closes
// it for the whole family in one pass (same pattern as orderOps/routes.js).
const returnBrand = requireResourceBrand('return_requests', { notFoundCode: 'RETURN_REQUEST_NOT_FOUND', notFoundMessage: 'Return request not found.', altColumn: 'request_number' });

router.get('/returns', read, c.listReturns);
router.get('/returns/export', read, c.exportReturns);
router.get('/returns/:id', read, returnBrand, c.getReturn);

router.post('/returns/:id/approve', manage, returnBrand, c.approveReturn);
router.post('/returns/:id/reject', manage, returnBrand, c.rejectReturn);
router.post('/returns/:id/prepare-pickup', manage, returnBrand, c.preparePickup);
router.post('/returns/:id/book-pickup', manage, returnBrand, c.bookPickup);
router.post('/returns/:id/mark-received', manage, returnBrand, c.markReceived);
router.post('/returns/:id/qc', manage, returnBrand, c.recordQc);
router.post('/returns/:id/release-replacement', manage, returnBrand, c.releaseReplacement);
router.post('/returns/:id/complete', manage, returnBrand, c.completeReturn);

router.post('/returns/:id/retry-refund', refund, returnBrand, c.retryRefund);
router.post('/returns/:id/settle-payout', refund, returnBrand, c.settleCodPayout);
router.post('/returns/:id/payout-destination', refund, returnBrand, c.revealPayoutDestination);
// reverse_shipments keys off its own id, not a return_request id directly —
// not covered here; flagged in PHASE-6.md as remaining follow-up.
router.post('/reverse-shipments/:id/reconcile', manage, c.reconcileReverse);

// Phase 2 · Slice 19 — RVP QC 3.0.
router.get('/returns/:id/qc-snapshot', read, returnBrand, c.getReturnQcSnapshot);
router.get('/qc-questions', read, c.listQcQuestions);
router.patch('/qc-questions/:clientQuestionId/mapping', manage, c.updateQcQuestionMapping);

export default router;
