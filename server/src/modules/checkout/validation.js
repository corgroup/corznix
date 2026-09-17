import { z } from 'zod';

export const idempotencySchema = z.object({ idempotencyKey: z.string().trim().min(8).max(64) }).strict();
const address = z.object({
  firstName: z.string().trim().min(1).max(120), lastName: z.string().trim().min(1).max(120),
  phone: z.string().trim().regex(/^\d{10}$/), addressLine1: z.string().trim().min(1).max(255),
  addressLine2: z.string().trim().max(255).optional(), city: z.string().trim().min(1).max(120),
  district: z.string().trim().max(120).optional(),
  state: z.string().trim().min(1).max(120), postalCode: z.string().regex(/^[1-9]\d{5}$/),
}).strict();
export const addressIntentSchema = z.union([
  z.object({ addressId: z.string().uuid() }).strict(),
  // replaceAddressId: the book entry an earlier save of this same draft
  // created, so autosave revises it rather than adding one per edit.
  z.object({ address, saveInfo: z.boolean().default(true), replaceAddressId: z.string().uuid().optional() }).strict(),
]);
export const shippingMethodSchema = z.object({ quoteId: z.string().uuid() }).strict();
export const paymentModeSchema = z.object({ mode: z.enum(['PREPAID','FULL_COD','PARTIAL_COD']) }).strict();
export const paymentSessionSchema = z.object({ providerCode: z.enum(['CASHFREE','RAZORPAY','MOCK_PAYMENT']).optional() }).strict();
// Razorpay Checkout's success callback as the storefront passes it on. The
// shapes are checked here; whether it is genuine is decided by
// PaymentService#verifyRazorpayCheckout (signature + Razorpay's own record).
export const razorpayVerifySchema = z.object({
  razorpayOrderId: z.string().regex(/^order_[A-Za-z0-9]{6,40}$/),
  razorpayPaymentId: z.string().regex(/^pay_[A-Za-z0-9]{6,40}$/),
  razorpaySignature: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

// 'MAX' is "use as much as this order allows" — the common case, and it keeps
// the browser from having to do the arithmetic (and getting it wrong).
export const storeCreditApplySchema = z.object({
  amountMinor: z.union([z.literal('MAX'), z.number().int().min(0).max(100000000)]),
}).strict();
