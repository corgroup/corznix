// Idempotent backfill of the initial Fulfillment for existing Orders that
// predate the forward-fulfillment domain.
//
// Safe to run repeatedly: the second pass is a no-op. Never recreates Orders,
// never touches payments / financial snapshots / inventory, never calls a
// logistics provider, never generates an AWB.
//
// LOCAL DEVELOPMENT ONLY — do not run against staging until
// COMMERCE_TRANSACTION_BOUNDARY_APPROVED = YES.
import { pool } from '../src/database/connection/pool.js';
import { backfillFulfillments } from '../src/modules/fulfillment/backfill.js';

const limit = Number(process.argv[2] || 500);
const summary = await backfillFulfillments({ limit });
console.log(JSON.stringify({ scope: 'fulfillment', event: 'backfill_complete', ...summary }, null, 2));
await pool.end();
