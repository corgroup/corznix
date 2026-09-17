import { Router } from 'express';
import { z } from 'zod';
import { unsubscribeWithToken } from './unsubscribe.js';

// Public: the person unsubscribing is usually not signed in. The token is
// the authority (see unsubscribe.js).
const router = Router();
const body = z.object({ token: z.string().trim().min(20).max(1024) });

// The storefront /unsubscribe page posts here after the reader confirms.
router.post('/unsubscribe', async (req, res, next) => {
  try {
    const { token } = body.parse(req.body ?? {});
    res.json({ data: await unsubscribeWithToken(token) });
  } catch (err) { next(err); }
});

// RFC 8058 one-click: the mail client POSTs to the List-Unsubscribe URL with
// the token in the query string and no confirmation step.
router.post('/unsubscribe/one-click', async (req, res, next) => {
  try {
    const { token } = body.parse({ token: req.query.t });
    res.json({ data: await unsubscribeWithToken(token) });
  } catch (err) { next(err); }
});

export default router;
