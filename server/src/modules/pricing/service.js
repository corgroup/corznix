import { AppError } from '../../utils/errors.js';
import { PricingRepository } from './repository.js';

export class PricingService {
  constructor({ repository = new PricingRepository() } = {}) {
    this.repository = repository;
  }

  async resolveSellable({ storefrontId, size }) {
    const normalizedSize = String(size || '').trim().toUpperCase();
    const row = await this.repository.findSellableByStorefrontIdAndSize(storefrontId, normalizedSize);
    if (!row) throw new AppError('SELLABLE_NOT_FOUND', 'The selected product or size is unavailable.', 404);
    return row;
  }

  priceRow(row) {
    const regularMinor = Number(row.price_minor);
    const saleMinor = row.sale_price_minor == null ? null : Number(row.sale_price_minor);
    const unitPriceMinor = saleMinor ?? regularMinor;
    const quantity = Number(row.quantity);
    return { unitPriceMinor, compareAtPriceMinor: saleMinor == null ? null : regularMinor, lineTotalMinor: unitPriceMinor * quantity };
  }
}

export const pricingService = new PricingService();
