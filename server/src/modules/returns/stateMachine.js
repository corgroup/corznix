import { AppError } from '../../utils/errors.js';

// Named, validated transitions for the return / exchange lifecycle (§31/§32).
// There is no "set status = X" — every move is one of these edges.
export const RETURN_TRANSITIONS = Object.freeze({
  REQUESTED: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['PICKUP_PENDING', 'CANCELLED', 'MANUAL_RETURN_LOGISTICS_REQUIRED'],
  PICKUP_PENDING: ['PICKUP_BOOKED', 'CANCELLED', 'MANUAL_RETURN_LOGISTICS_REQUIRED'],
  PICKUP_BOOKED: ['PICKED_UP', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED'],
  PICKED_UP: ['IN_TRANSIT', 'RECEIVED'],
  IN_TRANSIT: ['RECEIVED'],
  RECEIVED: ['QC_PASSED', 'QC_FAILED'],
  QC_PASSED: ['RESOLUTION_PENDING', 'COMPLETED'],
  QC_FAILED: ['RESOLUTION_PENDING', 'COMPLETED'],
  RESOLUTION_PENDING: ['COMPLETED'],
  MANUAL_RETURN_LOGISTICS_REQUIRED: ['PICKUP_PENDING', 'RECEIVED', 'CANCELLED'],
  COMPLETED: [],
  REJECTED: [],
  CANCELLED: [],
  EXPIRED: [],
});

export const TERMINAL_RETURN_STATUSES = Object.freeze(['COMPLETED', 'REJECTED', 'CANCELLED', 'EXPIRED']);

export function assertReturnTransition(from, to) {
  const allowed = RETURN_TRANSITIONS[from];
  if (!allowed) throw new AppError('INVALID_RETURN_STATE', `Unknown return status "${from}".`, 409);
  if (from === to) return; // idempotent re-issue of the same action is handled by callers
  if (!allowed.includes(to)) {
    throw new AppError('INVALID_RETURN_TRANSITION', `A return in ${from} cannot move to ${to}.`, 409);
  }
}
