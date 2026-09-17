import { AppError } from '../../utils/errors.js';

// Named ticket status transitions (§51). There is no "set status = X".
export const SUPPORT_TRANSITIONS = Object.freeze({
  OPEN: ['IN_PROGRESS', 'WAITING_CUSTOMER', 'WAITING_INTERNAL', 'RESOLVED', 'CLOSED'],
  IN_PROGRESS: ['WAITING_CUSTOMER', 'WAITING_INTERNAL', 'RESOLVED', 'CLOSED'],
  WAITING_CUSTOMER: ['IN_PROGRESS', 'WAITING_INTERNAL', 'RESOLVED', 'CLOSED'],
  WAITING_INTERNAL: ['IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED'],
  RESOLVED: ['IN_PROGRESS', 'CLOSED'],
  CLOSED: ['IN_PROGRESS'],
});

export const SUPPORT_TERMINAL = Object.freeze(['CLOSED']);
export const SUPPORT_CATEGORIES = Object.freeze(['GENERAL', 'ORDER', 'DELIVERY', 'PAYMENT', 'RETURN', 'EXCHANGE', 'PRODUCT']);
export const SUPPORT_PRIORITIES = Object.freeze(['LOW', 'NORMAL', 'HIGH', 'URGENT']);

export function assertSupportTransition(from, to) {
  if (from === to) return;
  const allowed = SUPPORT_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new AppError('INVALID_SUPPORT_TRANSITION', `A ticket in ${from} cannot move to ${to}.`, 409);
  }
}
