// Signed short-lived content preview (Wave 8E, Phase 7).
//
// A staff member mints an opaque token scoped to one surface (+ optional
// "as of" instant); the storefront passes it as ?preview=<token>. The
// public content resolvers then serve the DRAFT (unpublished) content for
// that scope only. Tokens are stored as a SHA-256 hash, expire in <= 1h,
// and are revocable. Anything wrong with the token -> it is ignored and the
// published content is served, so a leak can never widen public exposure.
import { randomUUID } from 'node:crypto';
import { AppError } from '../../utils/errors.js';
import { query } from '../../database/connection/pool.js';
import { hashToken, randomToken, toMysqlDateTime } from '../../utils/otpCrypto.js';
import { StaffAuditRepository } from '../staff/repositories.js';

const auditRepo = new StaffAuditRepository();
const DEFAULT_TTL_S = 15 * 60;
const MAX_TTL_S = 60 * 60;

const BASE_SCOPES = ['all', 'header', 'homepage', 'footer', 'faq', 'experience', 'pages'];
const SCOPE_RE = /^(all|header|homepage|footer|faq|experience|pages|page:[a-z0-9]+(?:-[a-z0-9]+)*)$/;

export function isValidScope(scope) {
  return SCOPE_RE.test(scope || '');
}

/** Does a token's scope authorise a preview of `requested` (e.g. 'header', 'page:our-story')? */
export function scopeCovers(tokenScope, requested) {
  if (tokenScope === 'all') return true;
  if (tokenScope === requested) return true;
  if (requested.startsWith('page:') && (tokenScope === 'pages')) return true;
  return false;
}

export async function createPreviewToken({ scope = 'all', asOf = null, ttlSeconds, label = null, staffId = null, actor = null }) {
  if (!isValidScope(scope)) throw new AppError('CONTENT_INVALID', `Invalid preview scope "${scope}".`, 422);
  let asOfMysql = null;
  if (asOf != null && asOf !== '') {
    const d = new Date(asOf);
    if (Number.isNaN(d.getTime())) throw new AppError('CONTENT_INVALID', `"${asOf}" is not a valid date/time.`, 422);
    asOfMysql = toMysqlDateTime(d);
  }
  const ttl = Math.min(Math.max(Number(ttlSeconds) || DEFAULT_TTL_S, 60), MAX_TTL_S);
  const token = randomToken(); // 32 bytes hex
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const id = randomUUID();
  await query(
    `INSERT INTO content_preview_tokens (id, token_hash, staff_user_id, scope, as_of, label, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW(3))`,
    [id, hashToken(token), staffId, scope, asOfMysql, label, toMysqlDateTime(expiresAt)],
  );
  auditRepo.log({
    staffUserId: staffId, actorEmail: actor?.email || null, ipAddress: actor?.ip || null, requestId: actor?.requestId || null,
    action: 'CONTENT_PREVIEW_TOKEN_CREATED', resourceType: 'content_preview_token', resourceId: id,
    metadata: { scope, asOf: asOfMysql, ttl },
  }).catch(() => {});
  return { id, token, scope, asOf: asOfMysql, expiresAt: expiresAt.toISOString(), ttlSeconds: ttl };
}

/** Returns { scope, asOf: Date|null, expiresAt } for a good token, else null. Never throws for a bad token. */
export async function resolvePreviewToken(token) {
  if (!token || typeof token !== 'string' || token.length < 32) return null;
  const rows = await query(
    'SELECT * FROM content_preview_tokens WHERE token_hash = ? LIMIT 1',
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  // best-effort usage bookkeeping
  query('UPDATE content_preview_tokens SET last_used_at = NOW(3), use_count = use_count + 1 WHERE id = ?', [row.id]).catch(() => {});
  return {
    id: row.id,
    scope: row.scope,
    asOf: row.as_of ? new Date(row.as_of) : null,
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

export async function listPreviewTokens(staffId) {
  const rows = await query(
    `SELECT id, scope, as_of, label, expires_at, revoked_at, created_at, last_used_at, use_count
     FROM content_preview_tokens
     WHERE (? IS NULL OR staff_user_id = ?) AND created_at > (NOW(3) - INTERVAL 2 DAY)
     ORDER BY created_at DESC LIMIT 50`,
    [staffId ?? null, staffId ?? null],
  );
  const now = Date.now();
  return {
    tokens: rows.map((r) => ({
      id: r.id, scope: r.scope, asOf: r.as_of ? new Date(r.as_of).toISOString() : null, label: r.label,
      expiresAt: new Date(r.expires_at).toISOString(),
      status: r.revoked_at ? 'REVOKED' : (new Date(r.expires_at).getTime() <= now ? 'EXPIRED' : 'ACTIVE'),
      createdAt: new Date(r.created_at).toISOString(),
      lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
      useCount: r.use_count,
    })),
  };
}

export async function revokePreviewToken(id, actor) {
  const res = await query('UPDATE content_preview_tokens SET revoked_at = NOW(3) WHERE id = ? AND revoked_at IS NULL', [id]);
  auditRepo.log({
    staffUserId: actor?.id || null, actorEmail: actor?.email || null, ipAddress: actor?.ip || null, requestId: actor?.requestId || null,
    action: 'CONTENT_PREVIEW_TOKEN_REVOKED', resourceType: 'content_preview_token', resourceId: String(id), metadata: {},
  }).catch(() => {});
  return { revoked: res.affectedRows > 0 };
}

/**
 * Express helper: given the request and a `requested` scope string, returns
 * a preview context { asOf } if a valid in-scope token is present, else
 * null. Also sets no-store / noindex headers when previewing.
 */
export async function previewContext(req, res, requested) {
  const token = req.query?.preview || req.get('x-content-preview') || null;
  if (!token) return null;
  const resolved = await resolvePreviewToken(String(token));
  if (!resolved || !scopeCovers(resolved.scope, requested)) return null;
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  return { asOf: resolved.asOf, scope: resolved.scope, expiresAt: resolved.expiresAt };
}

export { BASE_SCOPES };
