// Cart recovery links — the "Return to Cart" button in abandoned-cart
// marketing, and the CTA in the matching email.
//
// The link has to do three things the old `${STOREFRONT_BASE_URL}/cart` could
// not: name ONE customer's abandoned episode, survive the customer being
// signed out when they tap it, and never let that link reach someone else's
// cart. So:
//
//   issue()   mints a 32-byte random token, stores only its SHA-256, and
//             snapshots the abandoned lines as sku_id + quantity.
//   preview() is public (the recipient may be signed out) and returns only
//             what is already public about those products — name, image,
//             slug, size, colour, live price, live availability. No customer
//             name, no email, no internal ids beyond the storefront id the
//             product pages already use.
//   redeem()  REQUIRES the signed-in customer to be the customer the token was
//             issued to. A forwarded link redeems nothing for anybody else.
//
// Prices and stock are never restored from the snapshot: they are re-resolved
// from the catalogue every time, so a customer can neither check out at a
// stale price nor be sold something that ran out while the reminder sat in
// their inbox.
import { createHash, randomBytes } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { env, storefrontBaseUrl } from '../../config/index.js';
import { query } from '../../database/connection/pool.js';
import { cartService } from './service.js';

const log = logger('cart-recovery');

// Long enough that guessing is not a threat model, short enough to sit in a
// WhatsApp button URL suffix (Meta caps the whole URL, not just the suffix).
const TOKEN_BYTES = 24;
const DEFAULT_TTL_DAYS = 7;

const hashToken = (token) => createHash('sha256').update(String(token), 'utf8').digest('hex');

// Base64url: URL-safe, no padding, nothing a mail client will linkify wrongly.
const mintToken = () => randomBytes(TOKEN_BYTES).toString('base64url');

export class CartRecoveryService {
  constructor({ carts = cartService, db = query } = {}) {
    this.carts = carts;
    this.db = db;
  }

  /**
   * Mint a recovery token for one abandoned-cart episode.
   * @returns {{token:string, url:string, suffix:string, expiresAt:Date}}
   */
  async issue({ customerId, cartId, cartActivityAt, items, ttlDays = DEFAULT_TTL_DAYS }) {
    if (!customerId || !cartId) throw new AppError('VALIDATION_ERROR', 'customerId and cartId are required.', 400);
    const snapshot = (items || [])
      .filter((item) => item?.skuId && Number(item.quantity) > 0)
      .map((item) => ({ skuId: item.skuId, quantity: Number(item.quantity) }));
    if (!snapshot.length) throw new AppError('VALIDATION_ERROR', 'A recovery link needs at least one cart line.', 400);

    const token = mintToken();
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
    await this.db(
      `INSERT INTO cart_recovery_tokens (id, token_hash, customer_id, cart_id, cart_activity_at, items_json, expires_at)
       VALUES (?,?,?,?,?,CAST(? AS JSON),?)`,
      [randomUUID(), hashToken(token), customerId, cartId, new Date(cartActivityAt), JSON.stringify(snapshot), expiresAt],
    );
    return {
      token,
      // The suffix is what the approved WhatsApp template's dynamic URL button
      // appends to its base; the full URL is what the email links to. Both
      // resolve to the same storefront page.
      suffix: token,
      // storefrontBaseUrl, never the raw STOREFRONT_BASE_URL env value: production does not
      // set that variable, so it is the localhost default and every reminder
      // linked to http://localhost:5173 (production, 2026-09-17).
      url: `${storefrontBaseUrl}/cart/recover/${token}`,
      expiresAt,
    };
  }

  async #load(token) {
    if (!token || typeof token !== 'string' || token.length > 128) {
      throw new AppError('CART_RECOVERY_INVALID', 'This link is not valid.', 404);
    }
    const [row] = await this.db(
      `SELECT id, customer_id, cart_id, cart_activity_at, items_json, expires_at, redeemed_at
         FROM cart_recovery_tokens WHERE token_hash = ? LIMIT 1`,
      [hashToken(token)],
    );
    // A wrong token and an expired token are the same 404 on purpose: telling
    // a stranger "that one existed but expired" is information they have no
    // business having.
    if (!row) throw new AppError('CART_RECOVERY_INVALID', 'This link is not valid.', 404);
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      throw new AppError('CART_RECOVERY_EXPIRED', 'This cart link has expired. Your cart is still waiting for you when you sign in.', 410);
    }
    return row;
  }

  /**
   * Public preview — the recipient may be signed out. Returns only product
   * information that is already public on the storefront.
   */
  async preview(token) {
    const row = await this.#load(token);
    const snapshot = typeof row.items_json === 'string' ? JSON.parse(row.items_json) : row.items_json;
    const skuIds = snapshot.map((item) => item.skuId);
    const lines = await this.#resolveLines(skuIds);
    const byId = new Map(lines.map((line) => [line.skuId, line]));

    const items = snapshot.map((item) => {
      const live = byId.get(item.skuId);
      if (!live) return { available: false, quantity: item.quantity, name: 'This item is no longer available' };
      return {
        name: live.name,
        slug: live.slug,
        storefrontId: live.storefrontId,
        size: live.size,
        color: live.color,
        quantity: item.quantity,
        imageUrl: live.imageUrl,
        // Re-resolved right now, never the price at abandonment time.
        priceMinor: live.priceMinor,
        currency: live.currency,
        available: live.onHand === null ? true : live.onHand > 0,
        maxQuantity: live.onHand === null ? item.quantity : Math.max(0, live.onHand),
      };
    });
    return {
      items,
      itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
      // The storefront uses this to decide between "Sign in to restore" and
      // "Restore my cart" — it never learns WHO the customer is.
      requiresSignIn: true,
      expiresAt: row.expires_at,
    };
  }

  /**
   * Restore the snapshot into the signed-in customer's own cart.
   * The caller must already be authenticated; `customerId` is the session's,
   * never anything read out of the link.
   */
  async redeem(token, customerId) {
    const row = await this.#load(token);
    if (!customerId) throw new AppError('AUTH_REQUIRED', 'Sign in to restore your cart.', 401);
    if (row.customer_id !== customerId) {
      // A forwarded or guessed link must not touch this account's cart.
      log.warn('cart_recovery_owner_mismatch', { tokenId: row.id });
      throw new AppError('CART_RECOVERY_INVALID', 'This link is not valid.', 404);
    }

    const snapshot = typeof row.items_json === 'string' ? JSON.parse(row.items_json) : row.items_json;
    const before = await this.carts.getCart(customerId);
    const inCart = new Map(before.items.map((item) => [item.skuId, item]));

    const restored = [];
    const unavailable = [];
    for (const item of snapshot) {
      const existing = inCart.get(item.skuId);
      // Already there at >= the abandoned quantity: leave the customer's own
      // later edit alone rather than silently pushing it back up.
      if (existing && existing.quantity >= item.quantity) continue;
      const missing = item.quantity - (existing?.quantity || 0);
      try {
        if (existing) {
          // eslint-disable-next-line no-await-in-loop
          await this.carts.updateQuantity(customerId, existing.lineId, item.quantity);
        } else {
          // eslint-disable-next-line no-await-in-loop
          await this.carts.addItemBySku(customerId, item.skuId, missing);
        }
        restored.push({ skuId: item.skuId, quantity: item.quantity });
      } catch (error) {
        // Sold out or delisted since the reminder — reported to the customer,
        // never silently dropped, and never a failed restore of the rest.
        unavailable.push({ skuId: item.skuId, reason: error?.code || 'UNAVAILABLE' });
      }
    }

    if (!row.redeemed_at) {
      await this.db('UPDATE cart_recovery_tokens SET redeemed_at = NOW(3) WHERE id = ? AND redeemed_at IS NULL', [row.id]);
    }
    const cart = await this.carts.getCart(customerId);
    log.info('cart_recovery_redeemed', { tokenId: row.id, restored: restored.length, unavailable: unavailable.length });
    return { cart, restoredCount: restored.length, unavailable };
  }

  /** Live catalogue facts for a set of SKUs — name, media, price, stock. */
  async #resolveLines(skuIds) {
    if (!skuIds.length) return [];
    const placeholders = skuIds.map(() => '?').join(',');
    const rows = await this.db(
      `SELECT s.id AS sku_id, s.size, s.price_minor, p.name, p.slug, v.storefront_id, v.color_name,
              -- media_type = 'IMAGE' AND status = 'ACTIVE' are load-bearing: a
              -- GRADIENT row stores a CSS gradient string in its url column as
              -- the placeholder for an unphotographed product. Sent to Meta as a
              -- header image link that is not a URL at all, so the filter is
              -- what keeps a broken image card out of a customer's WhatsApp.
              (SELECT pm.url FROM product_media pm
                WHERE pm.status = 'ACTIVE' AND pm.media_type = 'IMAGE' AND pm.product_id = p.id
                  AND (pm.variant_id = v.id OR pm.variant_id IS NULL)
                ORDER BY (pm.variant_id = v.id) DESC, pm.position ASC LIMIT 1) AS media_url,
              (SELECT SUM(i.on_hand - i.reserved) FROM inventory i WHERE i.sku_id = s.id) AS on_hand
         FROM skus s
         JOIN product_variants v ON v.id = s.variant_id
         JOIN products p ON p.id = v.product_id
        WHERE s.id IN (${placeholders})
          AND s.status = 'ACTIVE' AND v.status = 'ACTIVE' AND p.status = 'ACTIVE'`,
      skuIds,
    );
    return rows.map((row) => ({
      skuId: row.sku_id,
      name: row.name,
      slug: row.slug,
      storefrontId: Number(row.storefront_id),
      size: row.size,
      color: row.color_name,
      imageUrl: row.media_url || null,
      priceMinor: Number(row.price_minor),
      currency: 'INR',
      onHand: row.on_hand === null ? null : Number(row.on_hand),
    }));
  }
}

export const cartRecoveryService = new CartRecoveryService();
