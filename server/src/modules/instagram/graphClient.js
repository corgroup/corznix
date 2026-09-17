import { ProviderError, PROVIDER_ERROR_CODES as C } from '../../platform/shared/providerError.js';

// The Instagram API (Instagram API with Instagram Login), official endpoints
// on graph.instagram.com. Only what the store needs: the connected account,
// its recent posts, token renewal, and downloading a post's picture so it can
// be kept in our own Media Library.
//
// Every failure leaves here as a ProviderError with a stable code. The access
// token travels in the query string (Instagram's documented form), so nothing
// here ever puts a request URL into an error or a log line.

export const INSTAGRAM_GRAPH_HOST = 'https://graph.instagram.com';
export const INSTAGRAM_GRAPH_VERSION = 'v25.0';
const MEDIA_FIELDS = 'id,media_type,media_product_type,media_url,thumbnail_url,permalink,shortcode,caption,timestamp';
const MAX_PICTURE_BYTES = 10 * 1024 * 1024;

const fail = (code, message, meta = {}) => new ProviderError({ code, message, capability: 'social', providerKey: 'INSTAGRAM', meta });

// Graph API error codes: 190 invalid/expired token; 10 and 200-299 missing
// permission; 4, 17, 32, 613 rate limits.
function classify(httpStatus, graphError) {
  const code = Number(graphError?.code);
  if (code === 190 || httpStatus === 401) return C.PROVIDER_AUTH_FAILED;
  if (code === 10 || (code >= 200 && code < 300) || httpStatus === 403) return C.PROVIDER_AUTH_FAILED;
  if ([4, 17, 32, 613].includes(code) || httpStatus === 429) return C.RATE_LIMITED;
  if (httpStatus >= 500) return C.PROVIDER_UNAVAILABLE;
  return C.PROVIDER_VALIDATION_FAILED;
}

export function createInstagramGraphClient({ fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = 10_000 } = {}) {
  async function request(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { signal: controller.signal });
    } catch (err) {
      throw fail(err?.name === 'AbortError' ? C.PROVIDER_TIMEOUT : C.PROVIDER_UNAVAILABLE, 'Instagram could not be reached.');
    } finally {
      clearTimeout(timer);
    }
  }

  async function get(path, params) {
    const url = new URL(`${INSTAGRAM_GRAPH_HOST}${path}`);
    for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
    const res = await request(url.toString());
    let body;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok || body?.error) {
      const graphError = body?.error || {};
      // Instagram's own message is a diagnosis ("Invalid OAuth access token"),
      // never the token itself; kept short.
      throw fail(
        classify(res.status, graphError),
        `Instagram said: ${String(graphError.message || `HTTP ${res.status}`).slice(0, 160)}`,
        { httpStatus: res.status, graphCode: graphError.code ?? null },
      );
    }
    if (!body || typeof body !== 'object') throw fail(C.PROVIDER_RESPONSE_INVALID, 'Instagram returned an unreadable response.');
    return body;
  }

  return {
    /** The account the token belongs to. */
    async profile(token) {
      const body = await get(`/${INSTAGRAM_GRAPH_VERSION}/me`, { fields: 'user_id,username,account_type', access_token: token });
      const igUserId = body.user_id ?? body.id;
      if (!igUserId || !body.username) throw fail(C.PROVIDER_RESPONSE_INVALID, 'Instagram did not say which account this token belongs to.');
      return { igUserId: String(igUserId), username: String(body.username), accountType: body.account_type ? String(body.account_type) : null };
    },

    /** The account's most recent posts, newest first, following Instagram's pages up to `max`. */
    async recentMedia(token, { max = 50 } = {}) {
      const posts = [];
      let after = null;
      while (posts.length < max) {
        const body = await get(`/${INSTAGRAM_GRAPH_VERSION}/me/media`, {
          fields: MEDIA_FIELDS, limit: Math.min(25, max - posts.length), after, access_token: token,
        });
        const page = Array.isArray(body.data) ? body.data : null;
        if (!page) throw fail(C.PROVIDER_RESPONSE_INVALID, 'Instagram returned posts in an unexpected shape.');
        posts.push(...page);
        after = body.paging?.cursors?.after || null;
        if (!after || !body.paging?.next || page.length === 0) break;
      }
      return posts.slice(0, max);
    },

    /** A renewed long-lived token (Instagram: the current one must be at least 24 hours old). */
    async refresh(token) {
      const body = await get('/refresh_access_token', { grant_type: 'ig_refresh_token', access_token: token });
      const expiresInSeconds = Number(body.expires_in);
      if (!body.access_token || !Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
        throw fail(C.PROVIDER_RESPONSE_INVALID, 'Instagram renewed the token without saying how long it lasts.');
      }
      return { token: String(body.access_token), expiresInSeconds };
    },

    /** A post's picture from Instagram's CDN, as bytes. */
    async downloadPicture(pictureUrl) {
      const res = await request(pictureUrl);
      if (!res.ok) throw fail(res.status >= 500 ? C.PROVIDER_UNAVAILABLE : C.PROVIDER_VALIDATION_FAILED, `Instagram's picture could not be downloaded (HTTP ${res.status}).`);
      const type = String(res.headers?.get?.('content-type') || '');
      if (!type.startsWith('image/')) throw fail(C.PROVIDER_RESPONSE_INVALID, 'Instagram sent something that is not a picture.');
      const buffer = Buffer.from(await res.arrayBuffer());
      if (!buffer.length || buffer.length > MAX_PICTURE_BYTES) throw fail(C.PROVIDER_RESPONSE_INVALID, 'Instagram sent a picture that is empty or too large.');
      return buffer;
    },
  };
}
