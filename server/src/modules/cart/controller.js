import { cartService } from './service.js';
import { cartRecoveryService } from './recoveryService.js';
import { addCartItemSchema, lineIdSchema, updateCartItemSchema } from './validation.js';

const respond = (res, data, status = 200) => res.status(status).json({ data });

// Public: the recipient of an abandoned-cart reminder may well be signed out
// when they tap the link. Returns product facts that are already public, and
// nothing that identifies the customer the link was issued to.
export async function previewRecovery(req, res, next) {
  try { respond(res, await cartRecoveryService.preview(req.params.token)); } catch (error) { next(error); }
}

// Authenticated: restores into the SIGNED-IN customer's own cart, and only if
// that is the customer the link was issued to.
export async function redeemRecovery(req, res, next) {
  try { respond(res, await cartRecoveryService.redeem(req.params.token, req.customer.id)); } catch (error) { next(error); }
}

export async function getCart(req, res, next) {
  try { respond(res, await cartService.getCart(req.customer.id)); } catch (error) { next(error); }
}

export async function addItem(req, res, next) {
  try { respond(res, await cartService.addItem(req.customer.id, addCartItemSchema.parse(req.body)), 201); } catch (error) { next(error); }
}

export async function updateItem(req, res, next) {
  try { respond(res, await cartService.updateQuantity(req.customer.id, lineIdSchema.parse(req.params.lineId), updateCartItemSchema.parse(req.body).quantity)); } catch (error) { next(error); }
}

export async function removeItem(req, res, next) {
  try { respond(res, await cartService.removeItem(req.customer.id, lineIdSchema.parse(req.params.lineId))); } catch (error) { next(error); }
}
