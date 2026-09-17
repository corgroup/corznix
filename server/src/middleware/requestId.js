import { randomUUID } from 'node:crypto';

// Wave 8J-1 — request id + correlation id.
//
// `req.id` keeps its existing meaning (per-request identity, echoed as
// X-Request-Id). `req.correlationId` is the value that flows into logs,
// provider attempts, outbox events and webhook records so one operation can
// be traced end to end. An inbound X-Correlation-Id is accepted only if it
// is a plausible token (defends against log-injection / unbounded values);
// otherwise a fresh one is minted.
const SAFE_CORRELATION = /^[A-Za-z0-9_.:-]{8,120}$/;

export function requestId(req, res, next) {
  req.id = req.headers['x-request-id'] && SAFE_CORRELATION.test(req.headers['x-request-id'])
    ? req.headers['x-request-id']
    : randomUUID();
  const inbound = req.headers['x-correlation-id'];
  req.correlationId = inbound && SAFE_CORRELATION.test(inbound) ? inbound : `req-${req.id}`;
  res.setHeader('X-Request-Id', req.id);
  res.setHeader('X-Correlation-Id', req.correlationId);
  next();
}
