import { adminAuditService } from './service.js';
import * as v from './validation.js';

const ok = (res, data) => res.status(200).json({ data });

export async function listAuditLogs(req, res, next) {
  try {
    const query = v.listQuerySchema.parse(req.query ?? {});
    ok(res, await adminAuditService.list(query));
  } catch (err) { next(err); }
}

export async function auditFacets(_req, res, next) {
  try {
    ok(res, await adminAuditService.facets());
  } catch (err) { next(err); }
}
