import { AppError } from '../../utils/errors.js';

// WP-12 / GAP-INV-04 — inter-warehouse transfer lifecycle.
//
//   DRAFT      created, nothing moved yet
//   DISPATCHED source on-hand decremented (TRANSFER_OUT); units in transit,
//              tracked only on this record — neither warehouse holds them
//   RECEIVED   destination on-hand incremented (TRANSFER_IN); terminal
//   CANCELLED  terminal; only reachable from DRAFT (nothing has moved)
//
// The schema also allows IN_TRANSIT as an optional marker between DISPATCHED
// and RECEIVED; it carries no stock effect, so it is folded away here — the
// stock-moving edges are the only ones this service exposes.
export const TRANSFER_STATUS = Object.freeze(['DRAFT', 'DISPATCHED', 'RECEIVED', 'CANCELLED']);

const GRAPH = Object.freeze({
  DRAFT: ['DISPATCHED', 'CANCELLED'],
  DISPATCHED: ['RECEIVED'],
  RECEIVED: [],
  CANCELLED: [],
});

export function assertTransferTransition(from, to) {
  if (!TRANSFER_STATUS.includes(to)) {
    throw new AppError('TRANSFER_TRANSITION_INVALID', `Unknown transfer status "${to}".`, 400);
  }
  if (!(GRAPH[from] || []).includes(to)) {
    throw new AppError('TRANSFER_TRANSITION_INVALID', `A transfer cannot move from ${from} to ${to}.`, 409);
  }
}
