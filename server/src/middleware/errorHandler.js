import { ZodError } from 'zod';
import { AppError } from '../utils/errors.js';
import { ProviderError, providerErrorToAppError } from '../platform/shared/providerError.js';
import { isProduction } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { increment } from '../utils/metrics.js';

const log = logger('http');

// `express.json()` rejects a malformed or oversized body with a plain Error
// carrying body-parser's own `type` discriminator. Those used to fall through
// to the 500 at the bottom of this file, which was wrong twice over: ordinary
// bad requests were counted and alerted on as server faults, and a client
// retrying on 5xx would retry forever a request that can never succeed.
//
// Matched on `type` rather than on a `status` property, so an unrelated
// library error that happens to carry one cannot pick its own response code.
const BODY_PARSER_ERRORS = {
  'entity.parse.failed': [400, 'MALFORMED_JSON', 'The request body is not valid JSON.'],
  'entity.verify.failed': [400, 'MALFORMED_BODY', 'The request body could not be read.'],
  'request.aborted': [400, 'REQUEST_ABORTED', 'The request ended before the body was received.'],
  'request.size.invalid': [400, 'MALFORMED_BODY', 'The request body could not be read.'],
  'entity.too.large': [413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.'],
  'encoding.unsupported': [415, 'UNSUPPORTED_ENCODING', 'The request body encoding is not supported.'],
  'charset.unsupported': [415, 'UNSUPPORTED_ENCODING', 'The request body encoding is not supported.'],
};

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const bodyParserError = BODY_PARSER_ERRORS[err?.type];
  if (bodyParserError) {
    const [status, code, message] = bodyParserError;
    // A fixed message: the parser's own text quotes the offending input back
    // at the caller and describes internals they have no use for.
    return res.status(status).json({ error: { code, message } });
  }

  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed.',
        details: err.flatten(),
      },
    });
  }

  // A normalized provider failure that reached the request boundary
  // unconverted — fold it into the safe domain error the frontend may see
  // (never the provider identity or the raw cause). See
  // platform/shared/providerError.js.
  if (err instanceof ProviderError) {
    const appError = providerErrorToAppError(err);
    return res.status(appError.status).json({
      error: { code: appError.code, message: appError.message },
    });
  }

  if (err instanceof AppError) {
    if (err.code === 'ORIGIN_FORBIDDEN') {
      // Rejected before any handler runs, so without this nothing says which
      // origin was turned away — the one fact needed to tell an attack from a
      // browser behaving differently.
      log.warn('origin_rejected', {
        method: req.method, route: req.path, origin: req.headers.origin ?? 'absent', correlationId: req.correlationId,
      });
    }
    return res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    });
  }

  increment('http_unhandled_error_total');
  log.error('unhandled_error', {
    method: req.method,
    route: `${req.baseUrl || ''}${req.route?.path || ''}` || req.path,
    correlationId: req.correlationId,
    requestId: req.id,
    errorName: err?.name,
    errorCode: err?.code,
    message: err?.message,
    stack: isProduction() ? undefined : err?.stack,
  });

  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: isProduction() ? 'An unexpected error occurred.' : err.message,
    },
  });
}
