// Normalizes an ApiError from @cor-group/api-client into a stable shape the
// CMS renders consistently (Wave 8A brief §37).
//   401 -> session/auth failure
//   403 -> permission denied
//   422/400 -> validation
//   429 -> rate limited
//   5xx / network -> system error
export function normalizeApiError(error) {
  const status = error?.status ?? null;
  const code = error?.code ?? 'UNKNOWN';

  if (status === 401) {
    return { kind: 'auth', status, code, message: 'Your session has ended. Please sign in again.' };
  }
  if (status === 403) {
    return { kind: 'permission', status, code, message: error?.message || 'You do not have permission to do that.' };
  }
  if (status === 422 || status === 400) {
    return { kind: 'validation', status, code, message: error?.message || 'Please check the form and try again.', details: error?.details };
  }
  if (status === 429) {
    return { kind: 'rateLimit', status, code, message: error?.message || 'Too many attempts. Please wait and try again.' };
  }
  if (status === null || (status >= 500 && status <= 599)) {
    return { kind: 'system', status, code, message: 'The service is temporarily unavailable. Please try again shortly.' };
  }
  return { kind: 'unknown', status, code, message: error?.message || 'Something went wrong.' };
}
