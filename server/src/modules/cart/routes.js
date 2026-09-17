import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import * as controller from './controller.js';

const router = Router();
// Declared BEFORE the authenticate gate on purpose: an abandoned-cart reminder
// lands on a browser that is often signed out, and a 401 there would read as
// "your cart is gone" to the customer. The preview is public; restoring into a
// cart is not.
router.get('/recovery/:token', controller.previewRecovery);
router.use(authenticate);
router.post('/recovery/:token/redeem', controller.redeemRecovery);
router.get('/', controller.getCart);
router.post('/items', controller.addItem);
router.patch('/items/:lineId', controller.updateItem);
router.delete('/items/:lineId', controller.removeItem);
export default router;
