import { env } from '../../config/index.js';

// The Government Open Data platform's API, for the Department of Posts PIN
// directory. Every failure leaves as a PostalSourceError with a kind, so the
// caller can say precisely why a lookup could not be verified instead of
// collapsing timeout, outage and malformed reply into one vague message.

export class PostalSourceError extends Error {
  constructor(kind, message, cause, { status = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'PostalSourceError';
    // NOT_CONFIGURED | TIMEOUT | NETWORK | RATE_LIMITED | HTTP | INVALID_RESPONSE
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    if (cause) this.cause = cause;
  }
}

const BASE = 'https://api.data.gov.in/resource/';

// Retry-After is either seconds or an HTTP date. Anything unreadable is
// ignored and the caller's own backoff applies.
const parseRetryAfter = (value) => {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
};

export async function fetchPostalRecords({
  filters = {},
  offset = 0,
  limit = 100,
  timeoutMs = env.POSTAL_LOOKUP_TIMEOUT_MS,
  apiKey = env.DATA_GOV_IN_API_KEY,
  resourceId = env.POSTAL_DIRECTORY_RESOURCE_ID,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) throw new PostalSourceError('NOT_CONFIGURED', 'DATA_GOV_IN_API_KEY is not set.');

  const url = new URL(resourceId, BASE);
  url.searchParams.set('api-key', apiKey);
  url.searchParams.set('format', 'json');
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('limit', String(limit));
  for (const [field, value] of Object.entries(filters)) url.searchParams.set(`filters[${field}]`, String(value));

  // The timer covers reading the body too: a server that sends headers and
  // then stalls would otherwise hang a checkout request indefinitely.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let text;
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (response.status === 429) {
      // The platform throttles bursts. Not an outage and not a bad key: the
      // same request succeeds once the caller slows down.
      throw new PostalSourceError('RATE_LIMITED', 'Directory rate limit reached (429).', null, {
        status: 429, retryAfterMs: parseRetryAfter(response.headers?.get?.('retry-after')),
      });
    }
    if (!response.ok) throw new PostalSourceError('HTTP', `Directory responded ${response.status}.`, null, { status: response.status });
    text = await response.text();
  } catch (error) {
    if (error instanceof PostalSourceError) throw error;
    const aborted = error?.name === 'AbortError' || controller.signal.aborted;
    throw new PostalSourceError(
      aborted ? 'TIMEOUT' : 'NETWORK',
      aborted ? `Directory did not answer within ${timeoutMs}ms.` : 'Directory could not be reached.',
      error,
    );
  } finally {
    clearTimeout(timer);
  }

  let body;
  try { body = JSON.parse(text); } catch (error) {
    throw new PostalSourceError('INVALID_RESPONSE', 'Directory reply was not JSON.', error);
  }

  // The platform reports some failures as HTTP 200 with a non-ok status.
  if (body && body.status && String(body.status).toLowerCase() !== 'ok') {
    throw new PostalSourceError('HTTP', String(body.message || 'Directory reported an error.'));
  }
  if (!body || !Array.isArray(body.records)) {
    throw new PostalSourceError('INVALID_RESPONSE', 'Directory reply had no records list.');
  }
  const total = Number(body.total);
  return { records: body.records, total: Number.isFinite(total) ? total : body.records.length };
}

/** A failure that a later attempt of the same request can plausibly fix. */
export const isTransientPostalError = (error) => error instanceof PostalSourceError
  && (['RATE_LIMITED', 'TIMEOUT', 'NETWORK'].includes(error.kind) || (error.kind === 'HTTP' && error.status >= 500));

const realSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * fetchPostalRecords for bulk work (the directory sync), which makes hundreds
 * of calls and must ride out throttling and brief outages. Transient failures
 * wait and retry — the server's Retry-After when it gives one, otherwise an
 * exponential backoff — and anything else (bad key, malformed reply) fails at
 * once, since repeating it cannot help. Never used on the checkout path: a
 * customer's lookup gives up after one try and the form stays manual.
 */
export async function fetchPostalRecordsWithRetry({
  attempts = 6, baseDelayMs = 5000, maxDelayMs = 120000, sleep = realSleep, onRetry = null, ...request
} = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetchPostalRecords(request);
    } catch (error) {
      if (!isTransientPostalError(error) || attempt >= attempts) throw error;
      const delayMs = Math.min(maxDelayMs, error.retryAfterMs ?? baseDelayMs * 2 ** (attempt - 1));
      onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
}
