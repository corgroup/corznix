import { Router } from 'express';
import * as addressesController from './controller.js';
import { authenticate } from '../../middleware/authenticate.js';

// NEW module (Wave 5). Every route is customer-scoped via `authenticate` +
// AddressService's ownership check — one customer address domain shared
// by Account (this wave) and a future Checkout (Wave 6), not two
// competing models (migration brief §79).
const router = Router();

router.use(authenticate);
router.get('/', addressesController.list);
router.post('/', addressesController.create);
router.put('/:id', addressesController.update);
router.post('/:id/default', addressesController.setDefault);
router.delete('/:id', addressesController.remove);

export default router;
