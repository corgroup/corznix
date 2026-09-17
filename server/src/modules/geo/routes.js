import { Router } from 'express';
import { query } from '../../database/connection/pool.js';
import { postalLookupLimiter } from '../../middleware/authRateLimit.js';
import { postalService } from './postalService.js';

// Reference geography. Public and unauthenticated: the checkout address form
// needs it before anyone has signed in, and there is nothing private about the
// list of Indian states.
//
// It lives here rather than in a frontend array because it is data, not code —
// it changes (Ladakh split from Jammu and Kashmir in 2019), and the business
// can stop offering a region by flipping is_active, with no release.
const router = Router();

// Small, identical for every caller, and changes about once a decade.
const TTL_SECONDS = 60 * 60 * 24;
// A PIN's offices change rarely, but a fresh sync should reach customers the
// same day.
const POSTAL_TTL_SECONDS = 60 * 60;
let cached = null;

router.get('/states', async (_req, res, next) => {
  try {
    if (!cached) {
      const rows = await query(
        `SELECT code, name, kind FROM geo_states
          WHERE is_active = 1 ORDER BY kind DESC, display_order ASC`);
      cached = {
        // Grouped as the form renders them, so the client does not re-derive
        // the split and get it subtly different.
        states: rows.filter((r) => r.kind === 'STATE').map(({ code, name }) => ({ code, name })),
        unionTerritories: rows.filter((r) => r.kind === 'UNION_TERRITORY').map(({ code, name }) => ({ code, name })),
      };
    }
    res.set('Cache-Control', `public, max-age=${TTL_SECONDS}`);
    res.json({ data: cached });
  } catch (err) { next(err); }
});

// PIN lookup against the Department of Posts directory. Always 200 with a
// status, because every outcome is an answer the form acts on — FOUND,
// NOT_FOUND ("could not verify"), INVALID (structurally impossible), or
// UNAVAILABLE (we could not ask). None of them blocks an address.
router.get('/pincodes/:pin', postalLookupLimiter, async (req, res, next) => {
  try {
    const result = await postalService.lookup(req.params.pin);
    // An outage must not be cached: the next customer should get a real answer
    // the moment the source is back.
    res.set('Cache-Control', result.status === 'UNAVAILABLE' ? 'no-store' : `public, max-age=${POSTAL_TTL_SECONDS}`);
    res.json({ data: result });
  } catch (err) { next(err); }
});

// Districts India Post lists for a state — suggestions for the District field,
// never a closed list.
router.get('/states/:code/districts', async (req, res, next) => {
  try {
    const result = await postalService.districtsForState(String(req.params.code || '').toUpperCase());
    res.set('Cache-Control', result.status === 'AVAILABLE' ? `public, max-age=${POSTAL_TTL_SECONDS}` : 'no-store');
    res.json({ data: result });
  } catch (err) { next(err); }
});

export default router;
