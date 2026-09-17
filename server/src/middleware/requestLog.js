import { logger } from '../utils/logger.js';
import { increment, observe } from '../utils/metrics.js';

const log = logger('http');

// Wave 8J-1 — one structured line per request: method, route TEMPLATE (never
// the raw URL with its query string / ids), status, duration. Body and query
// are never logged. Also feeds the metrics seam.
export function requestLog(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const route = `${req.baseUrl || ''}${req.route?.path || req.path || ''}` || req.path;
    const labels = { method: req.method, status: String(res.statusCode) };
    increment('http_requests_total', labels);
    observe('http_request_ms', ms, { method: req.method });
    if (res.statusCode >= 500) increment('http_5xx_total', { method: req.method });
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    log[level]('request', {
      method: req.method, route, status: res.statusCode,
      durationMs: Math.round(ms), correlationId: req.correlationId, requestId: req.id,
    });
  });
  next();
}
