import { logger } from './logger.js';
import { increment } from './metrics.js';

const log = logger('security');

// Wave 8J-2 — safe security-event trail. Records that something happened and
// enough to correlate it (ip, correlation id, route, actor id) — never a
// credential, token, header value or payload.
export function securityEvent(kind, req, extra = {}) {
  increment('security_event_total', { kind });
  log.warn(kind, {
    ip: req?.ip,
    method: req?.method,
    route: `${req?.baseUrl || ''}${req?.route?.path || ''}` || req?.path,
    correlationId: req?.correlationId,
    staffId: req?.staff?.id,
    customerId: req?.customer?.id,
    ...extra,
  });
}
