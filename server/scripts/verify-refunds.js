// Wave 8F-6 — refund / store credit / credit note verification.
//
// Refund state machine (PENDING/PROCESSING/SUCCEEDED/FAILED/UNKNOWN/BLOCKED),
// idempotent per return request (no duplicate provider effect); UNKNOWN needs
// reconciliation; refund amount cap (no financial overflow); store-credit
// refund = one GRANT; the original invoice is never mutated; partial-quantity
// credit note, idempotent; COD refund method BLOCKED until configured (never
// invented); GST reversal treatment left PENDING_CONFIGURATION.
//
//   npm run verify:refunds
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';
process.env.FULFILLMENT_RECOVERY_WORKER_ENABLED = 'false';
process.env.SHIPPING_PROVIDER_MODE = 'MOCK';

const { pool, query } = await import('../src/database/connection/pool.js');
const { fulfillmentService } = await import('../src/modules/fulfillment/service.js');
const { returnRequestService } = await import('../src/modules/returns/returnRequestService.js');
const { returnLifecycleService } = await import('../src/modules/returns/returnLifecycleService.js');
const { reverseShipmentService } = await import('../src/modules/returns/reverseShipmentService.js');
const { refundService, transitionCodPayout } = await import('../src/modules/returns/refundService.js');
const { returnPolicyService } = await import('../src/modules/returns/returnPolicyService.js');
const { refundPayoutService, maskPayout } = await import('../src/modules/returns/refundPayoutService.js');
const { payoutEncryptionAvailable } = await import('../src/utils/payoutCrypto.js');
const { storeCreditService } = await import('../src/modules/storeCredit/service.js');

const realFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = (...a) => { networkCalls += 1; return realFetch?.(...a); };

// Count real provider refund calls.
const { MockPaymentProvider } = await import('../src/modules/payments/providers/mockPaymentProvider.js');
let providerRefundCalls = 0;
const origRefund = MockPaymentProvider.prototype.refund;
MockPaymentProvider.prototype.refund = function patched(...a) { providerRefundCalls += 1; return origRefund.apply(this, a); };

const results = {};
const tag = randomUUID().slice(0, 8);
const created = { orders: [], customers: [], invoices: [] };

async function customer(name) {
  const id = randomUUID();
  created.customers.push(id);
  await query("INSERT INTO customers (id, brand_id,first_name,last_name,status,profile_completed_at) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,'T','ACTIVE',NOW(3))", [id, name]);
  return id;
}

async function paidOrder({ customerId, sku, qty = 1, paymentMode = 'PREPAID' }) {
  let cartId = (await query('SELECT id FROM carts WHERE customer_id=? LIMIT 1', [customerId]))[0]?.id;
  if (!cartId) { cartId = randomUUID(); await query('INSERT INTO carts (id, brand_id,customer_id,currency) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?)', [cartId, customerId, 'INR']); }
  const reservationId = randomUUID();
  await query(`INSERT INTO inventory_reservations (id, brand_id, customer_id,idempotency_key,request_fingerprint,status,expires_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'), ?,?,?, 'CONSUMED', DATE_ADD(NOW(3), INTERVAL 1 DAY))`, [reservationId, customerId, `rf:${randomUUID()}`, '0'.repeat(64)]);
  const def = (await query('SELECT id FROM warehouses WHERE is_default=1 LIMIT 1'))[0];
  await query('INSERT INTO inventory_reservation_items (id,reservation_id,warehouse_id,sku_id,quantity) VALUES (?,?,?,?,?)',
    [randomUUID(), reservationId, def.id, sku.id, qty]);
  const unit = Number(sku.price_minor || 50000);
  const subtotal = unit * qty;
  const online = paymentMode === 'FULL_COD' ? 0 : paymentMode === 'PARTIAL_COD' ? Math.round(subtotal * 0.3) : subtotal;
  const cod = subtotal - online;
  const checkoutId = randomUUID();
  await query(`INSERT INTO checkout_sessions (id, brand_id,customer_id,cart_id,inventory_reservation_id,idempotency_key,cart_fingerprint,status,currency,
       subtotal_minor,shipping_minor,total_minor,reservation_expires_at,expires_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,?,?, 'FINALIZED','INR', ?,0,?, DATE_ADD(NOW(3),INTERVAL 1 DAY), DATE_ADD(NOW(3),INTERVAL 1 DAY))`,
    [checkoutId, customerId, cartId, reservationId, `rf:co:${randomUUID()}`, 'f'.repeat(64), subtotal, subtotal]);
  const orderId = randomUUID();
  created.orders.push(orderId);
  const address = { firstName: 'RF', lastName: 'T', phone: '9999999999', addressLine1: '1 Rd', city: 'Lucknow', state: 'UP', postalCode: '226001', country: 'IN' };
  const payStatus = cod === 0 ? 'PAID' : online === 0 ? 'COD_DUE' : 'PARTIALLY_PAID';
  await query(`INSERT INTO orders (id, brand_id,order_number,checkout_id,customer_id,inventory_reservation_id,payment_status,payment_mode,currency,
       subtotal_minor,shipping_minor,total_minor,online_paid_minor,cod_due_minor,shipping_address_snapshot,shipping_snapshot,finalization_source)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,?,?,?, 'INR', ?,0,?,?,?,?,?, 'RF_TEST')`,
    [orderId, `COR-RF-${tag}-${created.orders.length}`, checkoutId, customerId, reservationId,
      payStatus, paymentMode, subtotal, subtotal, online, cod, JSON.stringify(address), JSON.stringify({ serviceLevel: 'STANDARD' })]);
  const orderItemId = randomUUID();
  await query(`INSERT INTO order_items (id,order_id,product_id,variant_id,sku_id,product_name,sku,quantity,unit_price_minor,line_total_minor)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [orderItemId, orderId, sku.product_id, sku.variant_id, sku.id, sku.name, sku.sku, qty, unit, subtotal]);

  // Real payment obligations + a SUCCEEDED online payment attempt (MOCK_PAYMENT).
  const onlineOblId = randomUUID();
  await query(`INSERT INTO payment_obligations (id,checkout_id,obligation_type,amount_minor,currency,status,source_payment_mode,order_id)
     VALUES (?,?, 'ONLINE', ?, 'INR', ?, ?, ?)`, [onlineOblId, checkoutId, online, online ? 'PAID' : 'NOT_REQUIRED', paymentMode, orderId]);
  await query(`INSERT INTO payment_obligations (id,checkout_id,obligation_type,amount_minor,currency,status,source_payment_mode,order_id)
     VALUES (?,?, 'COD', ?, 'INR', ?, ?, ?)`, [randomUUID(), checkoutId, cod, cod ? 'DUE' : 'NOT_REQUIRED', paymentMode, orderId]);
  if (online > 0) {
    await query(`INSERT INTO payment_attempts (id,obligation_id,checkout_id,provider_code,merchant_reference,provider_payment_id,amount_minor,currency,status,idempotency_key)
       VALUES (?,?,?, 'MOCK_PAYMENT', ?, ?, ?, 'INR', 'SUCCEEDED', ?)`,
      [randomUUID(), onlineOblId, checkoutId, `MR-${randomUUID().slice(0, 12)}`, `mock-pay-${randomUUID().slice(0, 8)}`, online, randomUUID()]);
  }

  await fulfillmentService.ensureForOrder(orderId);
  const deliveredAt = new Date(Date.now() - 86400000);
  await query(`UPDATE shipments s JOIN fulfillments f ON f.id=s.fulfillment_id
      SET s.status='DELIVERED', s.delivered_at=?, s.booking_status='BOOKED', s.provider_code='MOCK',
          s.external_shipment_id=?, s.tracking_number=?, s.booked_at=? WHERE f.order_id=?`,
    [deliveredAt, `EXT-${randomUUID().slice(0, 8)}`, `AWB-${randomUUID().slice(0, 8)}`, deliveredAt, orderId]);
  return { orderId, orderItemId, unit, subtotal, checkoutId };
}

async function syntheticInvoice(orderId) {
  const inv = randomUUID();
  const items = await query('SELECT * FROM order_items WHERE order_id=?', [orderId]);
  const subtotal = items.reduce((s, i) => s + Number(i.line_total_minor), 0);
  const tax = Math.round(subtotal * 0.05);
  await query(`INSERT INTO invoices (id, brand_id,order_id,invoice_number,currency,supplier_snapshot_json,billing_snapshot_json,shipping_snapshot_json,
       subtotal_minor,taxable_minor,cgst_minor,sgst_minor,igst_minor,grand_total_minor,status)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?, 'INR', ?, ?, ?, ?, ?, ?, ?, 0, ?, 'ISSUED')`,
    [inv, orderId, `COR-INV-RF-${randomUUID().slice(0, 8)}`, '{}', '{}', '{}', subtotal, subtotal, Math.round(tax / 2), Math.round(tax / 2), subtotal + tax]);
  created.invoices.push(inv);
  for (const it of items) {
    const lineTax = Math.round(Number(it.line_total_minor) * 0.05);
    await query(`INSERT INTO invoice_items (id,invoice_id,sku,product_name,quantity,unit_price_minor,taxable_minor,tax_minor,total_minor)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [randomUUID(), inv, it.sku, it.product_name, it.quantity, it.unit_price_minor, it.line_total_minor, lineTax, Number(it.line_total_minor) + lineTax]);
  }
  return inv;
}

async function driveReturnToResolutionPending(customerId, o, qty = 1, itemId = null, refundPayout = null) {
  const req = await returnRequestService.createRequest({
    customerId, orderId: o.orderId, requestType: 'RETURN', reasonCode: 'DEFECTIVE',
    idempotencyKey: `rf-${randomUUID().slice(0, 12)}`,
    items: [{ orderItemId: itemId || o.orderItemId, quantity: qty }],
    refundPayout,
  });
  await returnLifecycleService.approve({ requestId: req.id });
  await returnLifecycleService.preparePickup({ requestId: req.id });
  const b = await returnLifecycleService.bookPickup({ requestId: req.id, idempotencyKey: `rb-${req.id}` });
  await reverseShipmentService.ingestEvent({ returnShipmentId: b.reverseShipment.id, providerEventKey: `${req.id}-it`, normalizedStatus: 'IN_TRANSIT', occurredAt: new Date() });
  await returnLifecycleService.markReceived({ requestId: req.id });
  await returnLifecycleService.recordQc({ requestId: req.id, result: 'PASS' });
  return req;
}

try {
  const sku = (await query("SELECT s.id, s.sku, s.price_minor, s.variant_id, v.product_id, p.name FROM skus s JOIN product_variants v ON v.id=s.variant_id JOIN products p ON p.id=v.product_id WHERE s.status='ACTIVE' ORDER BY s.id LIMIT 1"))[0];
  await query("UPDATE skus SET price_minor=50000 WHERE id=?", [sku.id]); // deterministic money
  sku.price_minor = 50000;
  const cust = await customer('RFCust');
  await query("UPDATE return_policy SET refund_destination='ORIGINAL_PAYMENT', cod_refund_method=NULL WHERE id=1");
  returnPolicyService.invalidate();

  // ============ 1. ORIGINAL_PAYMENT refund + idempotency ============
  {
    const o = await paidOrder({ customerId: cust, sku, qty: 1, paymentMode: 'PREPAID' });
    await syntheticInvoice(o.orderId);
    const req = await driveReturnToResolutionPending(cust, o, 1);
    const callsBefore = providerRefundCalls;
    const done = await returnLifecycleService.completeResolution({ requestId: req.id });
    assert.equal(done.status, 'COMPLETED');
    const ra = (await query('SELECT * FROM refund_attempts WHERE return_request_id=?', [req.id]))[0];
    assert.equal(ra.method, 'ORIGINAL_PAYMENT');
    assert.equal(ra.provider_code, 'MOCK_PAYMENT');
    assert.equal(ra.status, 'SUCCEEDED');
    assert.ok(ra.provider_refund_id);
    assert.equal(Number(ra.amount_minor), 50000);
    assert.equal(providerRefundCalls, callsBefore + 1, 'exactly one provider refund call');

    // idempotent replay — no second provider effect
    const replay = await refundService.resolveForReturn({ returnRequestId: req.id });
    assert.equal(replay.replay, true);
    assert.equal(providerRefundCalls, callsBefore + 1, 'DUPLICATE_REFUND_EFFECTS = 0');
    assert.equal((await query('SELECT COUNT(*) c FROM refund_attempts WHERE return_request_id=?', [req.id]))[0].c, 1);
    results.refundDomain = 'PASS';
    results.refundIdempotency = 'PASS (DUPLICATE_REFUND_EFFECTS = 0)';

    // credit note: partial, invoice NOT mutated
    const cn = (await query('SELECT * FROM credit_notes WHERE return_request_id=?', [req.id]))[0];
    assert.ok(cn, 'partial credit note issued');
    assert.equal(cn.credit_note_type, 'PARTIAL_RETURN');
    assert.equal(cn.treatment_status, 'PENDING_CONFIGURATION');
    assert.equal(Number(cn.amount_minor), 50000);
    const cni = await query('SELECT * FROM credit_note_items WHERE credit_note_id=?', [cn.id]);
    assert.equal(cni.length, 1);
    assert.equal(Number(cni[0].quantity), 1);
    const inv = (await query('SELECT status FROM invoices WHERE order_id=?', [o.orderId]))[0];
    assert.equal(inv.status, 'ISSUED', 'ORIGINAL_INVOICE_MUTATION = 0');
    results.creditNoteIdempotency = 'PASS';
    results.originalInvoiceMutation = 0;
    results.partialQuantityCreditNote = 'PASS';
  }

  // ============ 2. Partial-quantity credit note (qty 2, return 1) ============
  {
    const o = await paidOrder({ customerId: cust, sku, qty: 2, paymentMode: 'PREPAID' });
    await syntheticInvoice(o.orderId);
    const req = await driveReturnToResolutionPending(cust, o, 1);
    await returnLifecycleService.completeResolution({ requestId: req.id });
    const cn = (await query('SELECT * FROM credit_notes WHERE return_request_id=?', [req.id]))[0];
    assert.equal(Number(cn.amount_minor), 50000, 'credit note covers only the returned unit');
    assert.equal(Number((await query('SELECT quantity FROM credit_note_items WHERE credit_note_id=?', [cn.id]))[0].quantity), 1);
    assert.equal((await query('SELECT status FROM invoices WHERE order_id=?', [o.orderId]))[0].status, 'ISSUED', 'whole invoice not reversed (§100)');
    // idempotent
    await refundService.resolveForReturn({ returnRequestId: req.id });
    assert.equal((await query('SELECT COUNT(*) c FROM credit_notes WHERE return_request_id=?', [req.id]))[0].c, 1, 'DUPLICATE_CREDIT_NOTES = 0');
    results.duplicateCreditNotes = 0;
  }

  // ============ 3. Refund UNKNOWN + reconciliation ============
  {
    const o = await paidOrder({ customerId: cust, sku, qty: 1, paymentMode: 'PREPAID' });
    const req = await driveReturnToResolutionPending(cust, o, 1);
    const callsBefore = providerRefundCalls;
    const r = await returnLifecycleService.completeResolution({ requestId: req.id, simulate: 'AMBIGUOUS' });
    void r;
    let ra = (await query('SELECT * FROM refund_attempts WHERE return_request_id=?', [req.id]))[0];
    assert.equal(ra.status, 'UNKNOWN');
    // blind retry -> no second provider call
    await refundService.resolveForReturn({ returnRequestId: req.id, simulate: 'AMBIGUOUS' });
    assert.equal(providerRefundCalls, callsBefore + 1, 'no blind duplicate refund');
    const rec = await refundService.reconcile({ refundAttemptId: ra.id, providerOutcome: 'SUCCEEDED' });
    assert.equal(rec.status, 'SUCCEEDED');
    results.refundUnknownHandling = 'PASS';
  }

  // ============ 4. Provider FAIL ============
  {
    const o = await paidOrder({ customerId: cust, sku, qty: 1, paymentMode: 'PREPAID' });
    const req = await driveReturnToResolutionPending(cust, o, 1);
    await returnLifecycleService.completeResolution({ requestId: req.id, simulate: 'FAIL' });
    assert.equal((await query('SELECT status FROM refund_attempts WHERE return_request_id=?', [req.id]))[0].status, 'FAILED');
    results.refundFailure = 'PASS';
  }

  // ============ 5. Store-credit refund = one GRANT ============
  {
    await query("UPDATE return_policy SET refund_destination='STORE_CREDIT' WHERE id=1");
    returnPolicyService.invalidate();
    const o = await paidOrder({ customerId: cust, sku, qty: 1, paymentMode: 'PREPAID' });
    const req = await driveReturnToResolutionPending(cust, o, 1);
    const balBefore = await storeCreditService.getBalanceMinor(cust);
    await returnLifecycleService.completeResolution({ requestId: req.id });
    assert.equal(await storeCreditService.getBalanceMinor(cust), balBefore + 50000);
    const grants = await query("SELECT * FROM store_credit_entries WHERE source_type='RETURN_RESOLUTION' AND source_id=?", [req.id]);
    assert.equal(grants.length, 1, 'DUPLICATE_STORE_CREDIT_GRANTS = 0');
    await refundService.resolveForReturn({ returnRequestId: req.id });
    assert.equal((await query("SELECT COUNT(*) c FROM store_credit_entries WHERE source_type='RETURN_RESOLUTION' AND source_id=?", [req.id]))[0].c, 1);
    assert.equal((await query('SELECT status,method FROM refund_attempts WHERE return_request_id=?', [req.id]))[0].method, 'STORE_CREDIT');
    results.storeCreditLedger = 'PASS';
    results.duplicateStoreCreditGrants = 0;
    await query("UPDATE return_policy SET refund_destination='ORIGINAL_PAYMENT' WHERE id=1");
    returnPolicyService.invalidate();
  }

  // ============ 6. Financial cap — no overflow ============
  {
    const o = await paidOrder({ customerId: cust, sku, qty: 3, paymentMode: 'PREPAID' });
    await query("UPDATE return_policy SET refund_destination='STORE_CREDIT' WHERE id=1");
    returnPolicyService.invalidate();
    const req1 = await driveReturnToResolutionPending(cust, o, 1);
    await returnLifecycleService.completeResolution({ requestId: req1.id });
    // Shrink the order's refundable value below what a second return would need.
    await query('UPDATE orders SET subtotal_minor=50000, shipping_minor=0, total_minor=50000, online_paid_minor=50000 WHERE id=?', [o.orderId]);
    const req2 = await driveReturnToResolutionPending(cust, o, 1);
    await assert.rejects(
      () => returnLifecycleService.completeResolution({ requestId: req2.id }),
      (e) => e.code === 'FINANCIAL_RESOLUTION_OVERFLOW',
    );
    results.refundAmountCap = 'PASS (FINANCIAL_RESOLUTION_OVERFLOW = 0)';
    await query('UPDATE orders SET subtotal_minor=150000, shipping_minor=0, total_minor=150000, online_paid_minor=150000 WHERE id=?', [o.orderId]);
    await query("UPDATE return_policy SET refund_destination='ORIGINAL_PAYMENT' WHERE id=1");
    returnPolicyService.invalidate();
  }

  // ============ 7. COD refund — paid to a customer-nominated destination ============
  // A COD order has no instrument to refund to. Blocking the refund left a
  // customer who had returned the goods with no money, so the customer
  // nominates a payout destination and operations pays it out.
  codSection: {
    // 7a. A COD RETURN cannot be raised without a destination — caught at
    // creation, not discovered later when the money cannot be moved.
    const oMissing = await paidOrder({ customerId: cust, sku, qty: 1, paymentMode: 'FULL_COD' });
    await assert.rejects(
      () => returnRequestService.createRequest({
        customerId: cust, orderId: oMissing.orderId, requestType: 'RETURN', reasonCode: 'DEFECTIVE',
        idempotencyKey: `rf-${randomUUID().slice(0, 12)}`,
        items: [{ orderItemId: oMissing.orderItemId, quantity: 1 }],
      }),
      (err) => err.code === 'REFUND_PAYOUT_REQUIRED',
      'a COD return without payout details is refused',
    );

    // 7b. UPI destination -> the refund is PENDING payout, never BLOCKED.
    const oUpi = await paidOrder({ customerId: cust, sku, qty: 1, paymentMode: 'FULL_COD' });
    const reqUpi = await driveReturnToResolutionPending(cust, oUpi, 1, null,
      { method: 'UPI', upiId: 'refund.test@okhdfcbank' });
    await returnLifecycleService.completeResolution({ requestId: reqUpi.id });
    const raUpi = (await query('SELECT * FROM refund_attempts WHERE return_request_id=?', [reqUpi.id]))[0];
    assert.equal(raUpi.method, 'COD_PAYOUT', 'COD refund is payable, not blocked');
    assert.equal(raUpi.status, 'PENDING');
    assert.equal(raUpi.failure_code, null);
    assert.equal(raUpi.provider_refund_id, null, 'a COD payout never goes to the payment gateway');

    // 7c. Bank destination -> account number encrypted at rest, last4 kept
    // for display, and the masked view carries no reusable digits.
    //
    // Without PAYOUT_ENCRYPTION_KEY the service refuses bank details rather
    // than storing them in the clear. That refusal IS the contract, so assert
    // it and skip the encryption assertions instead of failing on config.
    if (!payoutEncryptionAvailable()) {
      const oNoKey = await paidOrder({ customerId: cust, sku, qty: 1, paymentMode: 'FULL_COD' });
      await assert.rejects(
        () => returnRequestService.createRequest({
          customerId: cust, orderId: oNoKey.orderId, requestType: 'RETURN', reasonCode: 'DEFECTIVE',
          idempotencyKey: `rf-${randomUUID().slice(0, 12)}`,
          items: [{ orderItemId: oNoKey.orderItemId, quantity: 1 }],
          refundPayout: { method: 'BANK_ACCOUNT', accountHolderName: 'No Key', accountNumber: '123456789012345',
            confirmAccountNumber: '123456789012345', ifscCode: 'HDFC0001234' },
        }),
        (e) => e.code === 'PAYOUT_ENCRYPTION_UNAVAILABLE',
        'bank details are refused, never stored in the clear, without a key',
      );
      results.codRefund = 'PAYOUT_PENDING (UPI); bank refused — PAYOUT_ENCRYPTION_KEY not set';
      returnPolicyService.invalidate();
      break codSection;
    }

    // 7c (with a key). Account number encrypted at rest, last4 kept
    const oBank = await paidOrder({ customerId: cust, sku, qty: 1, paymentMode: 'FULL_COD' });
    const reqBank = await driveReturnToResolutionPending(cust, oBank, 1, null, {
      method: 'BANK_ACCOUNT', accountHolderName: 'Refund Test', accountNumber: '123456789012345',
      ifscCode: 'HDFC0001234', bankName: 'HDFC Bank',
    });
    const stored = (await query('SELECT * FROM refund_payout_details WHERE return_request_id=?', [reqBank.id]))[0];
    assert.equal(stored.method, 'BANK_ACCOUNT');
    assert.ok(!String(stored.account_number_cipher).includes('123456789012345'), 'account number is not stored in the clear');
    assert.equal(stored.account_number_last4, '2345');
    const masked = maskPayout(stored);
    assert.equal(masked.accountNumberMasked, '••••2345');
    assert.ok(!JSON.stringify(masked).includes('123456789012345'), 'the masked view leaks no account number');
    await returnLifecycleService.completeResolution({ requestId: reqBank.id });
    const raBank = (await query('SELECT method,status FROM refund_attempts WHERE return_request_id=?', [reqBank.id]))[0];
    assert.equal(raBank.method, 'COD_PAYOUT');
    assert.equal(raBank.status, 'PENDING');

    // 7d. The operator path can still recover the real destination.
    const revealed = await refundPayoutService.revealForPayout(reqBank.id);
    assert.equal(revealed.accountNumber, '123456789012345');
    assert.equal(revealed.ifscCode, 'HDFC0001234');


    // 7e. Operations settle the payout by hand — there is no provider to ask,
    // so each transition is explicit and a failed transfer stays workable.
    const lc = (action, extra = {}) => transitionCodPayout({ returnRequestId: reqBank.id, action, ...extra });
    assert.equal((await lc('START_PROCESSING')).status, 'PROCESSING');
    assert.equal((await lc('MARK_FAILED', { failureCode: 'BANK_REJECTED' })).status, 'FAILED');
    assert.equal((await lc('START_PROCESSING')).status, 'PROCESSING', 'a failed payout can be retried');
    const done = await lc('MARK_REFUNDED', { payoutReference: 'UTR123456789' });
    assert.equal(done.status, 'SUCCEEDED');
    assert.equal(done.payoutReference, 'UTR123456789');
    assert.equal(done.failureCode, null);
    await assert.rejects(() => lc('MARK_REFUNDED', { payoutReference: 'X' }),
      (e) => e.code === 'REFUND_ALREADY_COMPLETED', 'a completed payout is terminal');

    // A gateway refund must never be settleable by hand.
    const prepaid = await paidOrder({ customerId: cust, sku, qty: 1, paymentMode: 'PREPAID' });
    const prepaidReq = await driveReturnToResolutionPending(cust, prepaid, 1);
    await returnLifecycleService.completeResolution({ requestId: prepaidReq.id });
    await assert.rejects(() => transitionCodPayout({ returnRequestId: prepaidReq.id, action: 'MARK_REFUNDED', payoutReference: 'X' }),
      (e) => e.code === 'REFUND_NOT_MANUAL', 'only a COD payout is settled by hand');

    results.codPayoutLifecycle = 'PENDING -> PROCESSING -> FAILED -> PROCESSING -> SUCCEEDED (terminal)';
    results.codRefund = 'PAYOUT_PENDING (UPI + BANK_ACCOUNT), encrypted at rest, never gateway-routed';
  }

  // ============ 8. GST / accounting boundary ============
  {
    const o = await paidOrder({ customerId: cust, sku, qty: 1, paymentMode: 'PREPAID' });
    await syntheticInvoice(o.orderId);
    const req = await driveReturnToResolutionPending(cust, o, 1);
    const res = await refundService.resolveForReturn({ returnRequestId: req.id });
    assert.equal(res.resolution.finalAccountingGstValidation, 'NOT_YET');
    assert.equal(res.resolution.legalAccountingReviewRequired, true);
    const cn = (await query('SELECT treatment_status FROM credit_notes WHERE return_request_id=?', [req.id]))[0];
    assert.equal(cn.treatment_status, 'PENDING_CONFIGURATION', 'no fabricated GST reversal (§97/§98)');
    results.finalAccountingGstValidation = 'NOT_YET';
    results.legalAccountingReviewRequired = 'YES';
  }

  assert.equal(networkCalls, 0, 'no outbound network calls');
  results.realRefundProviderCalls = providerRefundCalls; // all MOCK
  results.status = 'PASS';
  console.log('\nREFUNDS_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nREFUNDS_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
  MockPaymentProvider.prototype.refund = origRefund;
  const safe = async (fn) => { try { await fn(); } catch (e) { console.error('  cleanup:', e.message); } };
  await safe(() => query("UPDATE return_policy SET refund_destination='ORIGINAL_PAYMENT', cod_refund_method=NULL WHERE id=1"));
  for (const orderId of created.orders) {
    for (const rid of (await query('SELECT id FROM return_requests WHERE order_id=?', [orderId])).map((r) => r.id)) {
      await safe(() => query('DELETE ci FROM credit_note_items ci JOIN credit_notes c ON c.id=ci.credit_note_id WHERE c.return_request_id=?', [rid]));
      await safe(() => query('DELETE FROM credit_notes WHERE return_request_id=?', [rid]));
      await safe(() => query('DELETE FROM refund_attempts WHERE return_request_id=?', [rid]));
      await safe(() => query('DELETE FROM return_shipment_booking_attempts WHERE return_shipment_id IN (SELECT id FROM return_shipments WHERE return_request_id=?)', [rid]));
      await safe(() => query('DELETE FROM return_shipment_events WHERE return_shipment_id IN (SELECT id FROM return_shipments WHERE return_request_id=?)', [rid]));
      await safe(() => query('DELETE FROM return_shipments WHERE return_request_id=?', [rid]));
    }
    await safe(() => query('DELETE ci FROM credit_note_items ci JOIN credit_notes c ON c.id=ci.credit_note_id WHERE c.order_id=?', [orderId]));
    await safe(() => query('DELETE FROM credit_notes WHERE order_id=?', [orderId]));
    await safe(() => query('DELETE ii FROM invoice_items ii JOIN invoices i ON i.id=ii.invoice_id WHERE i.order_id=?', [orderId]));
    await safe(() => query('DELETE FROM invoices WHERE order_id=?', [orderId]));
    await safe(() => query('DELETE s FROM shipments s JOIN fulfillments f ON f.id=s.fulfillment_id WHERE f.order_id=?', [orderId]));
    await safe(() => query('DELETE fe FROM fulfillment_events fe JOIN fulfillments f ON f.id=fe.fulfillment_id WHERE f.order_id=?', [orderId]));
    await safe(() => query('DELETE fi FROM fulfillment_items fi JOIN fulfillments f ON f.id=fi.fulfillment_id WHERE f.order_id=?', [orderId]));
    await safe(() => query('DELETE FROM fulfillments WHERE order_id=?', [orderId]));
    await safe(() => query('DELETE e FROM return_request_events e JOIN return_requests r ON r.id=e.return_request_id WHERE r.order_id=?', [orderId]));
    await safe(() => query('DELETE i FROM return_request_items i JOIN return_requests r ON r.id=i.return_request_id WHERE r.order_id=?', [orderId]));
    await safe(() => query('DELETE FROM return_requests WHERE order_id=?', [orderId]));
    await safe(() => query('DELETE pa FROM payment_attempts pa JOIN payment_obligations po ON po.id=pa.obligation_id WHERE po.order_id=?', [orderId]));
    await safe(() => query('DELETE FROM payment_obligations WHERE order_id=?', [orderId]));
    await safe(() => query('DELETE FROM order_items WHERE order_id=?', [orderId]));
    const chk = (await query('SELECT checkout_id, inventory_reservation_id FROM orders WHERE id=?', [orderId]))[0];
    await safe(() => query('DELETE FROM orders WHERE id=?', [orderId]));
    if (chk) {
      await safe(() => query('DELETE FROM payment_attempts WHERE checkout_id=?', [chk.checkout_id]));
      await safe(() => query('DELETE FROM payment_obligations WHERE checkout_id=?', [chk.checkout_id]));
      await safe(() => query('DELETE FROM checkout_sessions WHERE id=?', [chk.checkout_id]));
      await safe(() => query('DELETE FROM inventory_reservation_items WHERE reservation_id=?', [chk.inventory_reservation_id]));
      await safe(() => query('DELETE FROM inventory_reservations WHERE id=?', [chk.inventory_reservation_id]));
    }
  }
  for (const cid of created.customers) {
    await safe(() => query('DELETE FROM store_credit_entries WHERE customer_id=?', [cid]));
    await safe(() => query('DELETE FROM store_credit_accounts WHERE customer_id=?', [cid]));
    await safe(() => query('DELETE FROM carts WHERE customer_id=?', [cid]));
    await safe(() => query('DELETE FROM customers WHERE id=?', [cid]));
  }
  await pool.end();
}
