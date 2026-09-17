import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';
import { AppError } from '../../utils/errors.js';
import { encryptProviderSecret, decryptProviderSecret, providerSecretEncryptionAvailable } from '../../utils/providerSecretCrypto.js';
import { PROVIDER_ERROR_CODES as C } from '../../platform/shared/providerError.js';
import { withProviderAttempt } from '../platform/providerAttempts.js';
import { uploadMedia } from '../media/service.js';
import { createInstagramGraphClient } from './graphClient.js';

// The store's Instagram account, through the official API.
//
//   connect   an admin pastes an access token once; it is checked with
//             Instagram, stored encrypted, and the posts are pulled.
//   sync      the latest posts are saved; each post's picture is copied into
//             our Media Library (Instagram's picture links expire); a post
//             gone from Instagram is marked REMOVED.
//   renew     Instagram tokens last 60 days. Once a token is at least 24 hours
//             old and has under RENEW_WHEN_LEFT to go, it is renewed and the
//             exact expiry Instagram reports is stored.
//
// The token never leaves this module in the clear: not in a response, not in
// an error, not in a log. Every call to Instagram is recorded as a provider
// attempt, so CMS -> Providers shows the account's real health.

const CAP = 'social';
const KEY = 'INSTAGRAM';
const DAY_MS = 86_400_000;
const MIN_TOKEN_AGE_MS = DAY_MS;
const RENEW_WHEN_LEFT_MS = 20 * DAY_MS;
const SYNC_POSTS = 50;
// Instagram Login only works for professional accounts.
const PROFESSIONAL = new Set(['BUSINESS', 'MEDIA_CREATOR', 'CREATOR']);
const TOKEN_SHAPE = /^[A-Za-z0-9._|-]{20,2000}$/;

const toSqlDate = (d) => new Date(d).toISOString().slice(0, 23).replace('T', ' ');

async function defaultStoreCover(buffer, { brandId, shortcode }) {
  return uploadMedia(buffer, {
    brandId,
    folder: `brand/${brandId}/instagram`,
    originalFilename: `instagram-${shortcode || 'post'}.jpg`,
  });
}

/** What an admin is told when Instagram refuses, without Instagram's internals. */
function toAppError(err, fallbackMessage) {
  if (err instanceof AppError) return err;
  if (err?.code === C.PROVIDER_AUTH_FAILED) {
    return new AppError('INSTAGRAM_TOKEN_REJECTED', 'Instagram did not accept this access token. It may be expired, revoked, or missing the instagram_business_basic permission — create a new token and connect again.', 422);
  }
  if (err?.code === C.RATE_LIMITED) {
    return new AppError('INSTAGRAM_RATE_LIMITED', 'Instagram is limiting requests right now. Try again in a few minutes.', 429);
  }
  return new AppError('INSTAGRAM_UNAVAILABLE', fallbackMessage, 502);
}

export function createInstagramService({
  graph = createInstagramGraphClient(),
  storeCover = defaultStoreCover,
  now = () => new Date(),
} = {}) {
  const attempt = (operation, brandId, fn) => withProviderAttempt(
    { capability: CAP, providerKey: KEY, operation, resourceType: 'instagram_connection', resourceId: brandId },
    fn,
  );

  const connectionRow = async (brandId) => (await query('SELECT * FROM instagram_connections WHERE brand_id = ? LIMIT 1', [brandId]))[0] || null;

  const recordError = (brandId, err, { authFailed = false } = {}) => query(
    `UPDATE instagram_connections SET last_sync_error = ?${authFailed ? ", status = 'AUTH_FAILED'" : ''} WHERE brand_id = ?`,
    [String(err?.message || 'Instagram sync failed').slice(0, 255), brandId],
  );

  const service = {
    /** Connection state for the CMS. Never includes the token. */
    async status(brandId) {
      const row = await connectionRow(brandId);
      const [counts] = await query(
        `SELECT SUM(im.status = 'ACTIVE') AS live, SUM(im.status = 'ACTIVE' AND m.id IS NOT NULL) AS with_cover
           FROM instagram_media im
           LEFT JOIN media m ON m.id = im.cover_media_id AND m.status = 'ACTIVE'
          WHERE im.brand_id = ?`, [brandId]);
      return {
        encryptionAvailable: providerSecretEncryptionAvailable(),
        connected: Boolean(row),
        status: row?.status ?? null,
        username: row?.username ?? null,
        accountType: row?.account_type ?? null,
        tokenExpiresAt: row?.token_expires_at ?? null,
        tokenRefreshedAt: row?.token_refreshed_at ?? null,
        nextRenewalAfter: row?.token_refresh_after ?? null,
        lastSyncedAt: row?.last_synced_at ?? null,
        lastSyncError: row?.last_sync_error ?? null,
        connectedAt: row?.created_at ?? null,
        posts: { live: Number(counts?.live || 0), withCover: Number(counts?.with_cover || 0) },
      };
    },

    /** Check a pasted token with Instagram, store it encrypted, pull the posts. */
    async connect(brandId, rawToken, staffId = null) {
      const token = String(rawToken ?? '').trim();
      if (!TOKEN_SHAPE.test(token)) {
        throw new AppError('INSTAGRAM_TOKEN_INVALID', 'That does not look like an Instagram access token. Paste the whole token, with no spaces.', 422);
      }
      if (!providerSecretEncryptionAvailable()) encryptProviderSecret(''); // throws the "no encryption key" error
      let profile;
      try {
        profile = await attempt('instagram.profile', brandId, () => graph.profile(token));
      } catch (err) {
        throw toAppError(err, 'Instagram could not be reached to check this token. Try again in a moment.');
      }
      if (profile.accountType && !PROFESSIONAL.has(profile.accountType)) {
        throw new AppError('INSTAGRAM_ACCOUNT_NOT_PROFESSIONAL', `@${profile.username} is a personal account. Switch it to a professional (business or creator) account in Instagram, then connect again.`, 422);
      }
      const at = now();
      await query(
        `INSERT INTO instagram_connections
           (brand_id, ig_user_id, username, account_type, token_ciphertext, token_expires_at, token_refresh_after, token_refreshed_at, status, last_sync_error, connected_by_staff_id)
         VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, 'CONNECTED', NULL, ?)
         ON DUPLICATE KEY UPDATE ig_user_id = VALUES(ig_user_id), username = VALUES(username), account_type = VALUES(account_type),
           token_ciphertext = VALUES(token_ciphertext), token_expires_at = NULL, token_refresh_after = VALUES(token_refresh_after),
           token_refreshed_at = NULL, status = 'CONNECTED', last_sync_error = NULL, connected_by_staff_id = VALUES(connected_by_staff_id)`,
        [brandId, profile.igUserId, profile.username, profile.accountType, encryptProviderSecret(token),
          toSqlDate(at.getTime() + MIN_TOKEN_AGE_MS), staffId],
      );
      let sync = null;
      let syncError = null;
      try {
        sync = await service.sync(brandId);
      } catch (err) {
        syncError = err.message;
      }
      return { status: await service.status(brandId), sync, syncError };
    },

    /** Forget the account and its token. Synced posts stay, so the homepage keeps working. */
    async disconnect(brandId) {
      const res = await query('DELETE FROM instagram_connections WHERE brand_id = ?', [brandId]);
      return { disconnected: res.affectedRows > 0 };
    },

    /** Pull the latest posts and keep a copy of each picture. */
    async sync(brandId) {
      const row = await connectionRow(brandId);
      if (!row) throw new AppError('INSTAGRAM_NOT_CONNECTED', 'No Instagram account is connected.', 409);
      const token = decryptProviderSecret(row.token_ciphertext);

      let posts;
      try {
        posts = await attempt('instagram.media.list', brandId, () => graph.recentMedia(token, { max: SYNC_POSTS }));
      } catch (err) {
        await recordError(brandId, err, { authFailed: err?.code === C.PROVIDER_AUTH_FAILED });
        throw toAppError(err, 'Instagram could not be reached to fetch posts. The website keeps showing the posts it already has.');
      }

      const usable = posts.filter((p) => p && p.id && p.permalink && p.media_type);
      let added = 0;
      for (const p of usable) {
        const res = await query(
          `INSERT INTO instagram_media (id, brand_id, ig_media_id, media_type, media_product_type, shortcode, permalink, caption, posted_at, status, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', NOW(3))
           ON DUPLICATE KEY UPDATE media_type = VALUES(media_type), media_product_type = VALUES(media_product_type),
             shortcode = VALUES(shortcode), permalink = VALUES(permalink), caption = VALUES(caption),
             posted_at = VALUES(posted_at), status = 'ACTIVE', last_seen_at = NOW(3)`,
          [randomUUID(), brandId, String(p.id), String(p.media_type), p.media_product_type ? String(p.media_product_type) : null,
            p.shortcode ? String(p.shortcode) : null, String(p.permalink).slice(0, 500),
            p.caption ? String(p.caption) : null, p.timestamp ? toSqlDate(p.timestamp) : null],
        );
        if (res.affectedRows === 1) added += 1; // 2 = updated an existing row
      }

      // A post Instagram no longer lists inside the window it did return is gone.
      let removed = 0;
      if (usable.length) {
        const ids = usable.map((p) => String(p.id));
        const oldest = usable.map((p) => (p.timestamp ? new Date(p.timestamp).getTime() : Infinity)).reduce((a, b) => Math.min(a, b), Infinity);
        const wholeAccount = posts.length < SYNC_POSTS;
        const params = [brandId, ...ids];
        let windowSql = '';
        if (!wholeAccount && Number.isFinite(oldest)) { windowSql = ' AND posted_at >= ?'; params.push(toSqlDate(oldest)); }
        const res = await query(
          `UPDATE instagram_media SET status = 'REMOVED'
            WHERE brand_id = ? AND status = 'ACTIVE' AND ig_media_id NOT IN (${ids.map(() => '?').join(',')})${windowSql}`, params);
        removed = res.affectedRows;
      } else if (posts.length === 0) {
        const res = await query("UPDATE instagram_media SET status = 'REMOVED' WHERE brand_id = ? AND status = 'ACTIVE'", [brandId]);
        removed = res.affectedRows;
      }

      // Copy the picture of every live post that has none yet.
      const needCover = await query(
        `SELECT im.ig_media_id, im.shortcode FROM instagram_media im
           LEFT JOIN media m ON m.id = im.cover_media_id AND m.status = 'ACTIVE'
          WHERE im.brand_id = ? AND im.status = 'ACTIVE' AND m.id IS NULL`, [brandId]);
      const byId = new Map(usable.map((p) => [String(p.id), p]));
      let coversCopied = 0;
      let coverFailures = 0;
      for (const item of needCover) {
        const post = byId.get(item.ig_media_id);
        const pictureUrl = post?.thumbnail_url || post?.media_url;
        if (!pictureUrl) { coverFailures += 1; continue; }
        try {
          const buffer = await attempt('instagram.picture.download', brandId, () => graph.downloadPicture(pictureUrl));
          const asset = await storeCover(buffer, { brandId, shortcode: item.shortcode });
          await query('UPDATE instagram_media SET cover_media_id = ? WHERE brand_id = ? AND ig_media_id = ?', [asset.id, brandId, item.ig_media_id]);
          coversCopied += 1;
        } catch {
          coverFailures += 1;
        }
      }

      await query(
        `UPDATE instagram_connections SET last_synced_at = NOW(3), status = 'CONNECTED',
           last_sync_error = ? WHERE brand_id = ?`,
        [coverFailures ? `${coverFailures} post picture${coverFailures === 1 ? '' : 's'} could not be copied; they are not shown until the next sync copies them.` : null, brandId],
      );
      return { fetched: posts.length, added, updated: usable.length - added, removed, coversCopied, coverFailures };
    },

    /** Renew the token when Instagram allows it and it is getting old. */
    async renewIfDue(brandId) {
      const row = await connectionRow(brandId);
      if (!row || row.status !== 'CONNECTED') return { renewed: false, reason: 'not connected' };
      const at = now().getTime();
      if (at < new Date(row.token_refresh_after).getTime()) return { renewed: false, reason: 'too early' };
      if (row.token_expires_at && new Date(row.token_expires_at).getTime() - at > RENEW_WHEN_LEFT_MS) {
        return { renewed: false, reason: 'not due' };
      }
      const token = decryptProviderSecret(row.token_ciphertext);
      let renewed;
      try {
        renewed = await attempt('instagram.token.refresh', brandId, () => graph.refresh(token));
      } catch (err) {
        await recordError(brandId, err, { authFailed: err?.code === C.PROVIDER_AUTH_FAILED });
        throw toAppError(err, 'Instagram could not be reached to renew the access token. It will be tried again.');
      }
      const expiresAt = at + renewed.expiresInSeconds * 1000;
      const refreshAfter = Math.max(at + MIN_TOKEN_AGE_MS, expiresAt - RENEW_WHEN_LEFT_MS);
      await query(
        `UPDATE instagram_connections SET token_ciphertext = ?, token_expires_at = ?, token_refreshed_at = ?, token_refresh_after = ?
          WHERE brand_id = ?`,
        [encryptProviderSecret(renewed.token), toSqlDate(expiresAt), toSqlDate(at), toSqlDate(refreshAfter), brandId],
      );
      return { renewed: true, expiresAt: new Date(expiresAt).toISOString() };
    },

    /** Worker pass: renew when due, then sync, for every working connection. */
    async maintainAll({ brandId = null } = {}) {
      const rows = brandId
        ? await query("SELECT brand_id FROM instagram_connections WHERE status = 'CONNECTED' AND brand_id = ?", [brandId])
        : await query("SELECT brand_id FROM instagram_connections WHERE status = 'CONNECTED'");
      let synced = 0;
      let failed = 0;
      for (const { brand_id: brandId } of rows) {
        try {
          await service.renewIfDue(brandId);
          await service.sync(brandId);
          synced += 1;
        } catch {
          failed += 1; // already recorded on the connection
        }
      }
      return { accounts: rows.length, synced, failed };
    },

    /** Synced posts for the CMS picker, newest first, with their copied pictures. */
    async listPosts(brandId, { limit = 60 } = {}) {
      const n = Math.min(Math.max(Number(limit) || 60, 1), 200);
      const rows = await query(
        `SELECT im.ig_media_id, im.media_type, im.media_product_type, im.shortcode, im.permalink, im.caption, im.posted_at, im.status,
                m.url AS cover_url
           FROM instagram_media im
           LEFT JOIN media m ON m.id = im.cover_media_id AND m.status = 'ACTIVE'
          WHERE im.brand_id = ?
          ORDER BY im.posted_at DESC
          LIMIT ${n}`, [brandId]);
      return rows.map((r) => ({
        igMediaId: r.ig_media_id,
        kind: r.media_product_type === 'REELS' || r.media_type === 'VIDEO' ? 'reel' : 'post',
        shortcode: r.shortcode,
        permalink: r.permalink,
        caption: r.caption ? r.caption.slice(0, 280) : null,
        postedAt: r.posted_at,
        status: r.status,
        coverUrl: r.cover_url || null,
      }));
    },
  };
  return service;
}

export const instagramService = createInstagramService();
