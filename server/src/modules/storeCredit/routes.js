import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { storeCreditService } from './service.js';

// Customer-facing read model for the CORCOTTON Credit balance + ledger
// history. There is no customer write route — credit only ever moves through
// return / exchange resolution or a privileged staff action.
const router = Router();
router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const offset = req.query.offset ? Number(req.query.offset) : 0;
    res.json({ data: await storeCreditService.getSummary(req.customer.id, { limit, offset }) });
  } catch (error) { next(error); }
});

export default router;
