import { Router } from 'express';
import * as searchController from './controller.js';

// New module (Wave 4 — see docs/MIGRATION.md). Mounted at /api/v1/search.
// `GET /` is the only route — search has no create/update/delete surface.
const router = Router();

router.get('/', searchController.search);

export default router;
