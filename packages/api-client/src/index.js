/**
 * Shared HTTP client for CORCOTTON frontends (storefront, CMS).
 *
 * Deliberately small: base URL + JSON request helper + normalized errors.
 * Brand-specific or feature-specific API calls belong in each app's own
 * `src/services/`, built on top of an `ApiClient` instance — not here.
 */

/**
 * Normalized error thrown for any non-2xx response or network failure.
 */
export class ApiError extends Error {
  /**
   * @param {object} params
   * @param {number|null} params.status - HTTP status code, or null for network/parse failures.
   * @param {string} params.code - Machine-readable error code.
   * @param {string} params.message - Human-readable message.
   * @param {unknown} [params.details] - Optional extra detail (e.g. validation issues).
   */
  constructor({ status, code, message, details }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ApiClient {
  /**
   * @param {object} params
   * @param {string} params.baseURL - Origin of the API, e.g. "http://localhost:3000".
   * @param {() => (string|null|undefined)} [params.getAuthToken] - Optional accessor for a bearer token.
   * @param {() => (Record<string,string>|null|undefined)} [params.getDefaultHeaders] - Optional accessor for
   *   headers to merge into every request.
   */
  constructor({ baseURL, getAuthToken, getDefaultHeaders } = {}) {
    if (!baseURL) {
      throw new Error('ApiClient requires a baseURL (e.g. VITE_API_BASE_URL).');
    }
    this.baseURL = baseURL.replace(/\/+$/, '');
    this.getAuthToken = getAuthToken;
    this.getDefaultHeaders = getDefaultHeaders;
  }

  /**
   * @param {string} path - Path beginning with "/", e.g. "/api/v1/health".
   * @param {object} [options]
   * @param {string} [options.method]
   * @param {unknown} [options.body]
   * @param {Record<string,string>} [options.headers]
   * @param {AbortSignal} [options.signal] - cancels a request whose answer is no longer wanted.
   */
  async request(path, { method = 'GET', body, headers = {}, signal } = {}) {
    const url = `${this.baseURL}${path.startsWith('/') ? path : `/${path}`}`;
    const finalHeaders = { Accept: 'application/json', ...this.getDefaultHeaders?.(), ...headers };
    let payload;

    if (body instanceof FormData) {
      // multipart/form-data — let the browser set the Content-Type (with the
      // boundary). Used for media uploads in the CMS.
      payload = body;
    } else if (body !== undefined) {
      finalHeaders['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    const token = this.getAuthToken?.();
    if (token) {
      finalHeaders.Authorization = `Bearer ${token}`;
    }

    let response;
    try {
      response = await fetch(url, { method, headers: finalHeaders, body: payload, credentials: 'include', signal });
    } catch (networkError) {
      // A cancelled request is the caller's decision, not an outage — keep the
      // two distinguishable.
      if (networkError?.name === 'AbortError') {
        throw new ApiError({ status: null, code: 'ABORTED', message: `Request to ${path} was cancelled.` });
      }
      throw new ApiError({
        status: null,
        code: 'NETWORK_ERROR',
        message: `Could not reach ${url}: ${networkError.message}`,
      });
    }

    const contentType = response.headers.get('content-type') || '';
    const isJson = contentType.includes('application/json');
    const data = isJson ? await response.json().catch(() => null) : await response.text().catch(() => null);

    if (!response.ok) {
      const errBody = isJson && data && typeof data === 'object' ? data.error ?? data : null;
      throw new ApiError({
        status: response.status,
        code: errBody?.code ?? 'HTTP_ERROR',
        message: errBody?.message ?? `Request to ${path} failed with status ${response.status}`,
        details: errBody?.details,
      });
    }

    return data;
  }

  get(path, options) {
    return this.request(path, { ...options, method: 'GET' });
  }

  post(path, body, options) {
    return this.request(path, { ...options, method: 'POST', body });
  }

  put(path, body, options) {
    return this.request(path, { ...options, method: 'PUT', body });
  }

  patch(path, body, options) {
    return this.request(path, { ...options, method: 'PATCH', body });
  }

  delete(path, options) {
    return this.request(path, { ...options, method: 'DELETE' });
  }
}
