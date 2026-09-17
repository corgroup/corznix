import { z } from 'zod';

export const REASON_CODES = Object.freeze([
  'DEFECTIVE', 'DAMAGED_IN_TRANSIT', 'WRONG_ITEM', 'NOT_AS_DESCRIBED',
  'SIZE_FIT', 'QUALITY', 'CHANGED_MIND', 'OTHER',
]);

const reasonCode = z.enum(REASON_CODES);
const note = z.string().trim().max(1000);

const requestItem = z.object({
  orderItemId: z.string().trim().min(1),
  quantity: z.number().int().min(1).max(999),
  reasonCode: reasonCode.optional(),
  itemNote: note.optional(),
  // Exchange target — required for SAME_STYLE / DIFFERENT_STYLE, ignored otherwise.
  target: z.object({ skuId: z.string().trim().min(1) }).optional(),
});

export const createRequestBody = z.object({
  orderId: z.string().trim().min(1),
  requestType: z.enum(['RETURN', 'REPLACEMENT', 'SAME_STYLE_EXCHANGE', 'DIFFERENT_STYLE_EXCHANGE']),
  reasonCode: reasonCode.optional(),
  customerNote: note.optional(),
  idempotencyKey: z.string().trim().min(8).max(120),
  items: z.array(requestItem).min(1).max(50),
  // Required for a COD RETURN; the service enforces that, not the schema,
  // because it depends on the order's payment mode.
  refundPayout: z.lazy(() => refundPayoutBody).optional(),
});


// COD refund payout destination. A COD order has no instrument to refund to,
// so the customer names one. Validated here so an unpayable instruction never
// reaches the operations queue.
//
// UPI: handle@psp. IFSC: 4 letters, 0, then 6 alphanumerics (RBI format).
// Account numbers vary by bank (9-18 digits is the practical Indian range),
// so only length and digits are enforced - inventing a stricter rule would
// reject legitimate accounts.
const upiId = z.string().trim().min(3).max(120)
  .regex(/^[a-zA-Z0-9.-_]{2,64}@[a-zA-Z]{2,32}$/, 'Enter a valid UPI ID, for example name@bank.');
const ifsc = z.string().trim().toUpperCase()
  .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Enter a valid 11-character IFSC code.');
const accountNumber = z.string().trim().regex(/^[0-9]{9,18}$/, 'Enter a valid account number.');

export const refundPayoutBody = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('UPI'),
    upiId,
    accountHolderName: z.string().trim().min(2).max(160).optional(),
  }),
  z.object({
    method: z.literal('BANK_ACCOUNT'),
    accountHolderName: z.string().trim().min(2).max(160),
    accountNumber,
    confirmAccountNumber: accountNumber,
    ifscCode: ifsc,
    bankName: z.string().trim().min(2).max(120).optional(),
  }),
// The confirm check sits on the union, not inside the member: zod's
// discriminatedUnion needs each member to expose a raw object shape, and a
// .refine() wrapper hides it. Caught server-side because a mistyped account
// number pays a stranger and is not recoverable.
]).superRefine((v, ctx) => {
  if (v.method === 'BANK_ACCOUNT' && v.accountNumber !== v.confirmAccountNumber) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['confirmAccountNumber'], message: 'Account numbers do not match.' });
  }
});

export const eligibilityQuery = z.object({
  orderId: z.string().trim().min(1),
});

export const adminReturnsQuery = z.object({
  requestType: z.enum(['RETURN', 'REPLACEMENT', 'SAME_STYLE_EXCHANGE', 'DIFFERENT_STYLE_EXCHANGE']).optional(),
  status: z.string().trim().max(40).optional(),
  warehouseId: z.string().trim().min(1).optional(),
  qcPending: z.coerce.boolean().optional(),
  resolutionPending: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
}).default({});

export const qcBody = z.object({ result: z.enum(['PASS', 'FAIL']) });
export const retryRefundBody = z.object({
  refundAttemptId: z.string().trim().min(1).optional(),
  providerOutcome: z.enum(['SUCCEEDED', 'FAILED']).optional(),
}).default({});

// Operations working a COD payout by hand. The transition is explicit rather
// than inferred: money left the building or it did not, and only a person who
// looked at the bank portal knows which.
export const payoutTransitionBody = z.object({
  action: z.enum(['START_PROCESSING', 'MARK_REFUNDED', 'MARK_FAILED']),
  // The bank/UPI reference for the transfer. Required when marking refunded so
  // a completed payout is always traceable back to a real transaction.
  payoutReference: z.string().trim().min(3).max(140).optional(),
  note: z.string().trim().max(500).optional(),
  failureCode: z.string().trim().max(120).optional(),
}).superRefine((v, ctx) => {
  if (v.action === 'MARK_REFUNDED' && !v.payoutReference) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['payoutReference'], message: 'A payout reference is required when marking a refund complete.' });
  }
});

export const reconcileReverseBody = z.object({
  providerOutcome: z.enum(['CONFIRMED', 'NOT_CREATED']),
});

// Phase 2 · Slice 19 — the Delhivery POC enters the account-mapped question id.
export const qcQuestionMappingBody = z.object({
  delhiveryMappingStatus: z.enum(['PENDING', 'MAPPED', 'REJECTED']),
  delhiveryQuestionId: z.string().trim().max(64).optional(),
});

export const exchangeCheckoutBody = z.object({
  idempotencyKey: z.string().trim().min(8).max(120),
  items: z.array(z.object({
    skuId: z.string().trim().min(1),
    quantity: z.number().int().min(1).max(99),
  })).min(1).max(20),
});
