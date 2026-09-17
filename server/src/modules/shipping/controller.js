import { shippingService } from './service.js';
import { publicShippingOptionsSchema, checkDeliverySchema } from './validation.js';

export async function options(req, res, next) {
  try {
    const input = publicShippingOptionsSchema.parse(req.body);
    const items = input.context.skuId ? [{ skuId: input.context.skuId, quantity: input.context.quantity || 1 }] : [];
    const result = await shippingService.quote({ postalCode: input.postalCode, contextType: 'PRODUCT', items });
    res.json({ data: shippingService.toPublic(result) });
  } catch (error) { next(error); }
}

// Phase 2 · Slice 4 — PDP "check delivery" widget: serviceability + EDD window.
export async function checkDelivery(req, res, next) {
  try {
    const input = checkDeliverySchema.parse(req.body);
    const result = await shippingService.checkDelivery({
      postalCode: input.postalCode, skuId: input.skuId ?? null, quantity: input.quantity ?? 1,
    });
    res.json({ data: result });
  } catch (error) { next(error); }
}
