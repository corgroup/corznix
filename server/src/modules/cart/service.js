import { AppError } from '../../utils/errors.js';
import { pricingService } from '../pricing/service.js';
import { AVAILABILITY, inventoryService } from '../inventory/service.js';
import { CartRepository } from './repository.js';

// One cart line's ceiling; matches the cart validation schema.
const MAX_LINE_QUANTITY = 99;
const STOCK_REFUSALS = new Set(['INSUFFICIENT_STOCK', 'OUT_OF_STOCK']);

// A stock refusal that says what the customer can still have, so the storefront
// can offer that instead of a bare "no longer available".
const withQuantityDetails = (error, extra) => {
  if (!(error instanceof AppError) || !STOCK_REFUSALS.has(error.code)) return error;
  const available = Math.max(0, Number(error.details?.available ?? 0));
  return new AppError(error.code, error.message, error.status, { ...error.details, available, ...extra(available) });
};

export class CartService {
  constructor({ repository = new CartRepository(), pricing = pricingService, inventory = inventoryService } = {}) {
    this.repository = repository;
    this.pricing = pricing;
    this.inventory = inventory;
  }

  async getCart(customerId, { create = true, connection = null, lock = false } = {}) {
    const cart = create ? await this.repository.getOrCreate(customerId) : await this.repository.findForCustomer(customerId, connection, { lock });
    if (!cart) return { id: null, currency: 'INR', items: [], itemCount: 0, subtotalMinor: 0, updatedAt: null };
    const rows = await this.repository.loadRows(cart.id, connection);
    // The customer's own live checkout hold is theirs; it must not make their
    // own cart look sold out.
    const skuIds = [...new Set(rows.map((row) => row.sku_id))];
    const held = skuIds.length && this.inventory.heldByCustomer
      ? await this.inventory.heldByCustomer(customerId, skuIds, { connection }) : [];
    const heldBySku = new Map(held.map((row) => [row.sku_id, Number(row.quantity)]));
    const items = rows.map((row) => {
      const price = this.pricing.priceRow(row);
      const available = row.inventory_on_hand == null ? null
        : Number(row.inventory_on_hand) - Math.max(0, Number(row.inventory_reserved) - (heldBySku.get(row.sku_id) || 0));
      const availability = available == null ? AVAILABILITY.INVENTORY_NOT_CONFIGURED
        : available <= 0 ? AVAILABILITY.OUT_OF_STOCK
          : Number(row.quantity) > available ? AVAILABILITY.INSUFFICIENT_STOCK : AVAILABILITY.AVAILABLE;
      return {
        lineId: row.line_id, skuId: row.sku_id, sku: row.sku,
        productId: row.product_id, variantId: row.variant_id, storefrontId: Number(row.storefront_id),
        slug: row.slug, name: row.name, selectedSize: row.size, selectedColor: row.color_name,
        quantity: Number(row.quantity), ...price,
        // maxQuantity: the most this line can be set to right now.
        availability: { status: availability, maxQuantity: available == null ? 0 : Math.max(0, Math.min(MAX_LINE_QUANTITY, available)) },
        media: row.media_url ? { url: row.media_url, altText: row.media_alt } : null,
      };
    });
    return {
      id: cart.id, currency: cart.currency, items,
      itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
      subtotalMinor: items.reduce((sum, item) => sum + item.lineTotalMinor, 0),
      hasInventoryIssues: items.some((item) => item.availability.status !== AVAILABILITY.AVAILABLE),
      updatedAt: cart.updated_at,
    };
  }

  async addItem(customerId, input) {
    const sellable = await this.pricing.resolveSellable(input);
    const inCart = await this.repository.quantityForSku(customerId, sellable.sku_id);
    try {
      await this.inventory.assertAvailable([{ skuId: sellable.sku_id, quantity: inCart + input.quantity }], { customerId });
    } catch (error) {
      throw withQuantityDetails(error, (available) => ({
        inCart, requested: input.quantity, maxAddable: Math.max(0, Math.min(MAX_LINE_QUANTITY, available) - inCart),
      }));
    }
    await this.repository.addItem(customerId, sellable.sku_id, input.quantity);
    return this.getCart(customerId);
  }

  /**
   * Add by SKU id rather than (storefrontId, size). Cart recovery already
   * holds the exact SKU the customer abandoned, so re-resolving it from a
   * storefront id and a size label would be a chance to land on a different
   * variant — the one thing a recovery link must never do.
   */
  async addItemBySku(customerId, skuId, quantity) {
    const inCart = await this.repository.quantityForSku(customerId, skuId);
    await this.inventory.assertAvailable([{ skuId, quantity: inCart + quantity }], { customerId });
    await this.repository.addItem(customerId, skuId, quantity);
    return this.getCart(customerId);
  }

  async updateQuantity(customerId, lineId, quantity) {
    const line = await this.repository.findLineForCustomer(customerId, lineId);
    if (!line) throw new AppError('CART_ITEM_NOT_FOUND', 'Cart item not found.', 404);
    try {
      await this.inventory.assertAvailable([{ skuId: line.sku_id, quantity }], { customerId });
    } catch (error) {
      throw withQuantityDetails(error, (available) => ({
        requested: quantity, maxQuantity: Math.max(0, Math.min(MAX_LINE_QUANTITY, available)),
      }));
    }
    if (!await this.repository.updateQuantity(customerId, lineId, quantity)) {
      throw new AppError('CART_ITEM_NOT_FOUND', 'Cart item not found.', 404);
    }
    return this.getCart(customerId);
  }

  async removeItem(customerId, lineId) {
    if (!await this.repository.removeItem(customerId, lineId)) {
      throw new AppError('CART_ITEM_NOT_FOUND', 'Cart item not found.', 404);
    }
    return this.getCart(customerId);
  }
}

export const cartService = new CartService();
