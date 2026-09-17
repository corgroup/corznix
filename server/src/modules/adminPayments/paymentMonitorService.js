import { query } from '../../database/connection/pool.js';
import { resolvePeriod } from '../reporting/reportTime.js';

// One consolidated read of the payment picture: totals, status, instrument,
// COD vs prepaid, and refunds — assembled from the tables that already record
// them. It computes nothing new about money; `/reports/payments`,
// `/reports/cod` and reconciliation remain the detailed surfaces, and this
// agrees with them because it reads the same rows.
//
// Two rules it will not break:
//   * A payment counts as collected only when the BACKEND has it SUCCEEDED.
//     PENDING and CREATED are reported separately and never folded in.
//   * An instrument is reported only when the gateway told us what it was.
//     Attempts made before migration 097 have none, and are reported as
//     NOT_RECORDED rather than assigned to a bucket.

const n = (value) => Number(value || 0);

// Cashfree's payment_group values, mapped to the names an operator uses. An
// unrecognised group is passed through rather than swallowed into "other" —
// a new instrument should be visible, not hidden.
const GROUP_LABELS = Object.freeze({
  upi: 'UPI',
  net_banking: 'Net Banking',
  netbanking: 'Net Banking',
  credit_card: 'Credit Card',
  debit_card: 'Debit Card',
  card: 'Card (family not reported)',
  wallet: 'Wallet',
  emi: 'EMI',
  paylater: 'Pay Later',
  cardless_emi: 'Cardless EMI',
  banktransfer: 'Bank Transfer',
});
const label = (group) => (group ? GROUP_LABELS[group] || group : 'Not recorded');

const SUCCEEDED = ['SUCCEEDED', 'AUTHORIZED'];
const FAILED = ['FAILED'];
const CANCELLED = ['CANCELLED', 'EXPIRED'];
const OPEN = ['PENDING', 'CREATED'];

export class PaymentMonitorService {
  async monitor(q, brandId) {
    const { start, end, ...period } = resolvePeriod(q);

    const [attempts, refunds, codOrders, prepaidOrders, staleAttempts] = await Promise.all([
      query(
        `SELECT pa.status, pa.payment_group, pa.payment_method, pa.provider_code,
                COUNT(*) AS n, COALESCE(SUM(pa.amount_minor), 0) AS amount_minor
           FROM payment_attempts pa
           JOIN payment_obligations po ON po.id = pa.obligation_id
           JOIN orders o ON o.id = po.order_id
          WHERE pa.created_at >= ? AND pa.created_at < ? AND o.brand_id = ?
          GROUP BY pa.status, pa.payment_group, pa.payment_method, pa.provider_code`,
        [start, end, brandId],
      ),
      query(
        `SELECT ra.status, ra.method, ra.provider_code,
                COUNT(*) AS n, COALESCE(SUM(ra.amount_minor), 0) AS amount_minor
           FROM refund_attempts ra
          WHERE ra.created_at >= ? AND ra.created_at < ? AND ra.brand_id = ?
          GROUP BY ra.status, ra.method, ra.provider_code`,
        [start, end, brandId],
      ),
      query(
        `SELECT COUNT(*) AS orders,
                COALESCE(SUM(o.cod_due_minor), 0) AS due_minor,
                COALESCE(SUM(CASE WHEN o.order_status = 'CANCELLED' THEN o.cod_due_minor ELSE 0 END), 0) AS cancelled_minor
           FROM orders o
          WHERE o.cod_due_minor > 0 AND o.placed_at >= ? AND o.placed_at < ? AND o.brand_id = ?`,
        [start, end, brandId],
      ),
      query(
        `SELECT COUNT(*) AS orders, COALESCE(SUM(o.online_paid_minor), 0) AS paid_minor
           FROM orders o
          WHERE o.online_paid_minor > 0 AND o.placed_at >= ? AND o.placed_at < ? AND o.brand_id = ?`,
        [start, end, brandId],
      ),
      // A payment left open past its session is a reconciliation case, not a
      // failure — surfaced so it is chased rather than quietly counted as lost.
      query(
        `SELECT COUNT(*) AS n, COALESCE(SUM(pa.amount_minor), 0) AS amount_minor
           FROM payment_attempts pa
           JOIN payment_obligations po ON po.id = pa.obligation_id
           JOIN orders o ON o.id = po.order_id
          WHERE pa.status IN ('PENDING','CREATED') AND pa.session_expires_at IS NOT NULL
            AND pa.session_expires_at < NOW(3) AND o.brand_id = ?`,
        [brandId],
      ),
    ]);

    const codCollected = await query(
      `SELECT COALESCE(SUM(sh.cod_collection_minor), 0) AS collected_minor
         FROM shipments sh
         JOIN fulfillments f ON f.id = sh.fulfillment_id AND f.return_request_id IS NULL
         JOIN orders o ON o.id = f.order_id
        WHERE o.placed_at >= ? AND o.placed_at < ? AND o.brand_id = ?`,
      [start, end, brandId],
    );

    const bucket = (rows, statuses) => rows
      .filter((r) => statuses.includes(r.status))
      .reduce((acc, r) => ({ count: acc.count + n(r.n), amountMinor: acc.amountMinor + n(r.amount_minor) }), { count: 0, amountMinor: 0 });

    // ---- by instrument ----------------------------------------------
    const byGroup = new Map();
    for (const row of attempts) {
      const key = row.payment_group || null;
      if (!byGroup.has(key)) {
        byGroup.set(key, {
          group: key, label: label(key), recorded: Boolean(key),
          succeeded: { count: 0, amountMinor: 0 }, failed: { count: 0, amountMinor: 0 },
          cancelled: { count: 0, amountMinor: 0 }, open: { count: 0, amountMinor: 0 },
          methods: new Set(),
        });
      }
      const entry = byGroup.get(key);
      if (row.payment_method) entry.methods.add(row.payment_method);
      const target = SUCCEEDED.includes(row.status) ? entry.succeeded
        : FAILED.includes(row.status) ? entry.failed
          : CANCELLED.includes(row.status) ? entry.cancelled
            : OPEN.includes(row.status) ? entry.open : null;
      if (target) { target.count += n(row.n); target.amountMinor += n(row.amount_minor); }
    }

    // Refunds carry their own `method` (how the money went back), which is not
    // the instrument the customer paid with — they are reported side by side,
    // never merged, because a COD refund is not a gateway reversal.
    const refundsByMethod = new Map();
    for (const row of refunds) {
      const key = row.method || 'NOT_RECORDED';
      if (!refundsByMethod.has(key)) {
        refundsByMethod.set(key, { method: key, succeeded: { count: 0, amountMinor: 0 }, failed: { count: 0, amountMinor: 0 }, processing: { count: 0, amountMinor: 0 }, unknown: { count: 0, amountMinor: 0 } });
      }
      const entry = refundsByMethod.get(key);
      const target = row.status === 'SUCCEEDED' ? entry.succeeded
        : row.status === 'FAILED' ? entry.failed
          : ['PROCESSING', 'PENDING'].includes(row.status) ? entry.processing : entry.unknown;
      target.count += n(row.n); target.amountMinor += n(row.amount_minor);
    }

    const cod = codOrders[0] || {};
    const prepaid = prepaidOrders[0] || {};
    const collected = n(codCollected[0]?.collected_minor);

    return {
      period, timezone: 'Asia/Kolkata', generatedAt: new Date().toISOString(),
      payments: {
        succeeded: bucket(attempts, SUCCEEDED),
        failed: bucket(attempts, FAILED),
        cancelled: bucket(attempts, CANCELLED),
        open: bucket(attempts, OPEN),
        total: attempts.reduce((acc, r) => ({ count: acc.count + n(r.n), amountMinor: acc.amountMinor + n(r.amount_minor) }), { count: 0, amountMinor: 0 }),
        byProvider: attempts.reduce((acc, r) => {
          const found = acc.find((x) => x.providerCode === r.provider_code && x.status === r.status);
          if (found) { found.count += n(r.n); found.amountMinor += n(r.amount_minor); return acc; }
          return [...acc, { providerCode: r.provider_code, status: r.status, count: n(r.n), amountMinor: n(r.amount_minor) }];
        }, []),
        note: 'Collected = attempts the backend itself moved to SUCCEEDED after verifying with the gateway. A storefront redirect never marks a payment paid.',
      },
      byInstrument: [...byGroup.values()]
        .map((e) => ({ ...e, methods: [...e.methods] }))
        .sort((a, b) => b.succeeded.amountMinor - a.succeeded.amountMinor),
      instrumentCoverage: {
        recordedAttempts: attempts.filter((r) => r.payment_group).reduce((s, r) => s + n(r.n), 0),
        unrecordedAttempts: attempts.filter((r) => !r.payment_group).reduce((s, r) => s + n(r.n), 0),
        note: 'The instrument has only been recorded since migration 097. Older attempts show as "Not recorded" and are never guessed into a bucket.',
      },
      cod: {
        orders: n(cod.orders),
        dueMinor: n(cod.due_minor),
        collectedMinor: collected,
        outstandingMinor: n(cod.due_minor) - collected,
        cancelledMinor: n(cod.cancelled_minor),
        note: 'Collected is what the carrier recorded against a shipment. No carrier remittance feed is integrated, so this is CORCOTTON\'s own record, not a settlement statement.',
      },
      prepaid: { orders: n(prepaid.orders), paidMinor: n(prepaid.paid_minor) },
      refunds: {
        succeeded: refunds.filter((r) => r.status === 'SUCCEEDED').reduce((a, r) => ({ count: a.count + n(r.n), amountMinor: a.amountMinor + n(r.amount_minor) }), { count: 0, amountMinor: 0 }),
        failed: refunds.filter((r) => r.status === 'FAILED').reduce((a, r) => ({ count: a.count + n(r.n), amountMinor: a.amountMinor + n(r.amount_minor) }), { count: 0, amountMinor: 0 }),
        processing: refunds.filter((r) => ['PROCESSING', 'PENDING'].includes(r.status)).reduce((a, r) => ({ count: a.count + n(r.n), amountMinor: a.amountMinor + n(r.amount_minor) }), { count: 0, amountMinor: 0 }),
        unknown: refunds.filter((r) => !['SUCCEEDED', 'FAILED', 'PROCESSING', 'PENDING'].includes(r.status)).reduce((a, r) => ({ count: a.count + n(r.n), amountMinor: a.amountMinor + n(r.amount_minor) }), { count: 0, amountMinor: 0 }),
        byMethod: [...refundsByMethod.values()],
        note: 'UNKNOWN is a reconciliation exception and is never folded into succeeded or failed.',
      },
      attention: {
        expiredOpenAttempts: { count: n(staleAttempts[0]?.n), amountMinor: n(staleAttempts[0]?.amount_minor) },
        note: 'Attempts still open past their session expiry. Neither collected nor failed — they need reconciling.',
      },
    };
  }
}

export const paymentMonitorService = new PaymentMonitorService();
