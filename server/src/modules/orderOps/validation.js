import { z } from 'zod';

import { WORKFLOW_KEYS } from './workflowBuckets.js';

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD').optional();

export const listOrdersQuery = z.object({
  workflow: z.enum(WORKFLOW_KEYS).optional(),
  status: z.enum(['PLACED', 'CONFIRMED', 'PROCESSING', 'COMPLETED', 'CANCELLED']).optional(),
  paymentStatus: z.enum(['PAID', 'COD_DUE', 'PARTIALLY_PAID']).optional(),
  fulfillmentStatus: z.enum(['UNFULFILLED', 'FULFILLED', 'CANCELLED']).optional(),
  placedFrom: isoDay,
  placedTo: isoDay,
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const confirmOrderBody = z.object({
  expectedAllocationFingerprint: z.string().trim().length(64).optional(),
}).default({});

export const bookShipmentBody = z.object({
  idempotencyKey: z.string().trim().min(8).max(120),
  simulate: z.enum(['AMBIGUOUS']).optional(),
});

// Phase 2 · Slice 16
export const labelBody = z.object({
  size: z.enum(['4R', 'A4']).optional(),
}).default({});

// The operator asserts the physical facts they are responsible for. The label
// checkbox is what stamps label_printed_at, so the audit fact survives even
// though "Mark printed" is no longer a button of its own.
export const readyForPickupBody = z.object({
  pickupDate: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/, 'pickupDate must be YYYY-MM-DD.'),
  pickupTime: z.string().regex(/^[0-9]{2}:[0-9]{2}:[0-9]{2}$/).optional(),
  labelPrinted: z.boolean().optional(),
});

// One operator action; three backend steps that were three buttons.
export const manifestBody = z.object({
  weightGrams: z.number().int().positive().max(200_000),
  lengthMm: z.number().int().positive().max(5000),
  widthMm: z.number().int().positive().max(5000),
  heightMm: z.number().int().positive().max(5000),
  idempotencyKey: z.string().trim().min(8).max(120),
});

export const pickupBody = z.object({
  pickupDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'pickupDate must be YYYY-MM-DD.'),
  pickupTime: z.string().regex(/^\d{2}:\d{2}:\d{2}$/).optional(),
}).refine((b) => b.pickupDate, { message: 'pickupDate is required.' });

export const cancelShipmentBody = z.object({
  reason: z.string().trim().max(500).optional(),
}).default({});

// Phase 2 · Slice 17 — pull a proof document from the carrier.
export const carrierDocumentFetchBody = z.object({
  docType: z.enum(['EPOD', 'QC_IMAGE', 'SIGNATURE']),
});

// Phase 2 · Slice 18 — NDR action.
export const ndrActionBody = z.object({
  action: z.enum(['RE_ATTEMPT', 'RESCHEDULE']),
  instructions: z.string().trim().max(500).optional(),
});

// Phase 2 · Slice 8 — confirmed physical package (integers: grams / mm).
const posInt = z.number().int().positive();
export const packageBody = z.object({
  weightGrams: posInt.max(200_000),
  lengthMm: posInt.max(5000),
  widthMm: posInt.max(5000),
  heightMm: posInt.max(5000),
});
