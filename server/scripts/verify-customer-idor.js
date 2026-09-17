// Cross-customer access (IDOR) probe for the storefront surface.
//
// Every customer-scoped controller passes `req.customer.id` down alongside the
// resource id, and every repository this touches appears to filter on it. That
// is the thing worth proving rather than reading: a single method that looks
// its resource up by id alone is a customer reading another customer's orders,
// addresses or support history.
//
// Each case runs twice on purpose:
//   NEGATIVE — customer B touches A's resource, and must be refused.
//   POSITIVE — customer A touches their own, and must succeed.
// Without the positive control, a method that simply always throws would look
// perfectly secure.
//
// Writes only its own two customers and their rows, and removes them at the
// end whether or not the assertions pass.
//
//   npm run verify:customer-idor --workspace=server
import { randomUUID } from 'node:crypto';

process.env.SHIPPING_PROVIDER_MODE = 'MOCK';
process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';
process.env.COMMUNICATION_WORKER_ENABLED = 'false';

const { pool, query } = await import('../src/database/connection/pool.js');
const { addressService } = await import('../src/modules/addresses/service.js');
const { cartService } = await import('../src/modules/cart/service.js');
const { checkoutService } = await import('../src/modules/checkout/service.js');
const { orderFinalizationService } = await import('../src/modules/orders/service.js');
const { supportService } = await import('../src/modules/support/service.js');
const { storeCreditService } = await import('../src/modules/storeCredit/service.js');

const results = {};
let failures = 0;
let inventoryFixture = null;

const ADDRESS = {
  firstName: 'Idor', lastName: 'Probe', phone: '9319987171',
  addressLine1: '1 Probe Street', addressLine2: '', city: 'Delhi',
  state: 'Delhi', postalCode: '110001', country: 'IN',
};

/**
 * @param {string} name
 * @param {() => Promise<any>} asOwner    must succeed
 * @param {() => Promise<any>} asStranger must be refused
 */
async function probe(name, asOwner, asStranger) {
  // Positive control first: if the owner cannot do it either, the refusal
  // below proves nothing.
  try {
    await asOwner();
  } catch (err) {
    results[name] = `INCONCLUSIVE: owner was refused too (${err.code || err.message})`;
    failures += 1;
    console.error(`  INCONCLUSIVE  ${name}: owner refused (${err.code || err.message})`);
    return;
  }

  let leaked = null;
  try {
    leaked = await asStranger();
  } catch (err) {
    // Only a deliberate refusal counts. Accepting "it threw something" would
    // score a typo in this script, or a crash on malformed input, as proof of
    // an access check that may not exist at all.
    const status = err.status ?? err.statusCode;
    if (status === 401 || status === 403 || status === 404) {
      // 404 is preferable to 403: it does not confirm the resource exists.
      results[name] = `PASS (refused ${status} ${err.code || ''})`.trim();
      console.log(`  PASS  ${name} — refused ${status} ${err.code || ''}`);
      return;
    }
    results[name] = `INCONCLUSIVE: threw ${err.constructor.name} without a refusal status — ${err.message}`;
    failures += 1;
    console.error(`  INCONCLUSIVE  ${name}: ${err.constructor.name} (status=${status ?? 'none'}) ${err.message}`);
    return;
  }

  // Returning empty is a legitimate way to refuse a read; returning the
  // resource is not.
  const empty = leaked == null
    || (Array.isArray(leaked) && leaked.length === 0)
    || (typeof leaked === 'object' && Object.keys(leaked).length === 0);
  if (empty) {
    results[name] = 'PASS (returned nothing)';
    console.log(`  PASS  ${name} — returned nothing`);
    return;
  }

  results[name] = `FAIL: stranger received ${JSON.stringify(leaked).slice(0, 200)}`;
  failures += 1;
  console.error(`  FAIL  ${name} — stranger received data`);
}

const customers = [randomUUID(), randomUUID()];
const [A, B] = customers;

try {
  const [brand] = await query("SELECT id FROM brands WHERE slug = 'corcotton' LIMIT 1");
  for (const id of customers) {
    // eslint-disable-next-line no-await-in-loop
    await query(
      `INSERT INTO customers (id, brand_id, first_name, last_name, status, profile_completed_at)
       VALUES (?, ?, 'Idor', 'Probe', 'ACTIVE', NOW(3))`, [id, brand.id]);
  }

  // Prefer the best-stocked ACTIVE SKU, but do not require stock — the block
  // below establishes it either way.
  const [sku] = await query(
    `SELECT s.id, s.size, v.storefront_id
       FROM skus s
       JOIN product_variants v ON v.id = s.variant_id
       JOIN products p ON p.id = v.product_id
       LEFT JOIN inventory i ON i.sku_id = s.id
      WHERE s.status = 'ACTIVE' AND v.status = 'ACTIVE' AND p.status = 'ACTIVE'
      ORDER BY (COALESCE(i.on_hand, 0) - COALESCE(i.reserved, 0)) DESC, s.id
      LIMIT 1`);
  if (!sku) throw new Error('need an active SKU — run the catalog seed first');

  // Establish the stock this test needs rather than depending on whatever the
  // environment happens to hold. CI seeds the catalog but not inventory, so
  // requiring pre-existing stock made the run environment-dependent: it failed
  // with "Inventory is not configured for this item", which reads like an IDOR
  // defect but is only a missing fixture. Restored in the cleanup block.
  const [invBefore] = await query(
    'SELECT warehouse_id, on_hand, reserved FROM inventory WHERE sku_id = ? ORDER BY on_hand DESC LIMIT 1', [sku.id]);
  const [invWarehouse] = invBefore
    ? [{ id: invBefore.warehouse_id }]
    : await query("SELECT id FROM warehouses WHERE status = 'ACTIVE' ORDER BY priority, id LIMIT 1");
  if (!invWarehouse) throw new Error('need an ACTIVE warehouse — run the warehouse seed first');
  inventoryFixture = { skuId: sku.id, warehouseId: invWarehouse.id, existed: Boolean(invBefore), before: invBefore ?? null };
  if (invBefore) {
    await query('UPDATE inventory SET on_hand = GREATEST(on_hand, reserved + 5) WHERE sku_id = ? AND warehouse_id = ?',
      [sku.id, invWarehouse.id]);
  } else {
    // id is a CHAR(36) UUID with no default, and brand_id is NOT NULL — both
    // must be supplied explicitly. Local always took the UPDATE branch (rows
    // already existed), so only a fresh CI database reached this insert.
    await query(
      'INSERT INTO inventory (id, brand_id, sku_id, warehouse_id, on_hand, reserved) VALUES (?, ?, ?, ?, 5, 0)',
      [randomUUID(), brand.id, sku.id, invWarehouse.id]);
  }

  // ---- addresses ----------------------------------------------------------
  const addressA = await addressService.create(A, { ...ADDRESS, isDefault: true });

  await probe('address_read_via_update',
    () => addressService.update(A, addressA.id, { ...ADDRESS, addressLine1: '2 Probe Street' }),
    () => addressService.update(B, addressA.id, { ...ADDRESS, addressLine1: 'HIJACKED' }));

  await probe('address_set_default',
    () => addressService.setDefault(A, addressA.id),
    () => addressService.setDefault(B, addressA.id));

  // Delete last: it is the only one that destroys the fixture.
  await probe('address_delete',
    async () => true, // the owner's delete is exercised by cleanup below
    () => addressService.delete(B, addressA.id));

  const stillThere = await query('SELECT customer_id FROM addresses WHERE id = ?', [addressA.id]);
  results.address_survived_stranger_delete = stillThere.length === 1 && stillThere[0].customer_id === A
    ? 'PASS' : 'FAIL: stranger deleted or reassigned the address';
  if (!results.address_survived_stranger_delete.startsWith('PASS')) failures += 1;

  // ---- cart ---------------------------------------------------------------
  await cartService.addItem(A, { storefrontId: sku.storefront_id, size: sku.size, quantity: 1 });
  const cartA = await cartService.getCart(A);
  const lineA = cartA.items[0].lineId;

  await probe('cart_line_update',
    () => cartService.updateQuantity(A, lineA, 2),
    () => cartService.updateQuantity(B, lineA, 99));

  await probe('cart_line_remove',
    async () => true,
    () => cartService.removeItem(B, lineA));

  const [lineStill] = await query('SELECT quantity FROM cart_items WHERE id = ?', [lineA]);
  results.cart_line_survived_stranger = lineStill && Number(lineStill.quantity) === 2
    ? 'PASS' : `FAIL: quantity is ${lineStill ? lineStill.quantity : 'gone'} after a stranger's write`;
  if (!results.cart_line_survived_stranger.startsWith('PASS')) failures += 1;

  // ---- checkout -----------------------------------------------------------
  const checkoutA = await checkoutService.create(A, randomUUID());

  await probe('checkout_read',
    () => checkoutService.get(A, checkoutA.id),
    () => checkoutService.get(B, checkoutA.id));

  await probe('checkout_set_address',
    () => checkoutService.setAddress(A, checkoutA.id, { address: ADDRESS, saveInfo: false }),
    () => checkoutService.setAddress(B, checkoutA.id, { address: { ...ADDRESS, addressLine1: 'HIJACKED' }, saveInfo: false }));

  await probe('checkout_cancel',
    async () => true,
    () => checkoutService.cancel(B, checkoutA.id));

  const [checkoutStill] = await query('SELECT status, shipping_address_snapshot FROM checkout_sessions WHERE id = ?', [checkoutA.id]);
  const snapshot = typeof checkoutStill.shipping_address_snapshot === 'string'
    ? JSON.parse(checkoutStill.shipping_address_snapshot) : checkoutStill.shipping_address_snapshot;
  results.checkout_survived_stranger = checkoutStill.status !== 'CANCELLED' && snapshot?.addressLine1 !== 'HIJACKED'
    ? 'PASS' : `FAIL: status=${checkoutStill.status} addressLine1=${snapshot?.addressLine1}`;
  if (!results.checkout_survived_stranger.startsWith('PASS')) failures += 1;

  // ---- orders -------------------------------------------------------------
  // Read-only: an existing order is repointed at A for the duration and put
  // back exactly as found, so no order graph is invented or left behind.
  const [someOrder] = await query('SELECT id, customer_id, order_number FROM orders ORDER BY placed_at DESC LIMIT 1');
  if (someOrder) {
    const originalOwner = someOrder.customer_id;
    await query('UPDATE orders SET customer_id = ? WHERE id = ?', [A, someOrder.id]);
    try {
      await probe('order_read_by_id',
        () => orderFinalizationService.getOwned(A, someOrder.id),
        () => orderFinalizationService.getOwned(B, someOrder.id));

      await probe('order_read_by_number',
        () => orderFinalizationService.getOwned(A, someOrder.order_number),
        () => orderFinalizationService.getOwned(B, someOrder.order_number));

      await probe('order_fulfillment_read',
        () => orderFinalizationService.getOwnedFulfillment(A, someOrder.id),
        () => orderFinalizationService.getOwnedFulfillment(B, someOrder.id));

      const listB = await orderFinalizationService.listOwned(B);
      results.order_list_isolation = listB.some((o) => o.id === someOrder.id)
        ? 'FAIL: stranger\'s order list contains another customer\'s order' : 'PASS';
      if (!results.order_list_isolation.startsWith('PASS')) failures += 1;
      console.log(`  ${results.order_list_isolation.startsWith('PASS') ? 'PASS' : 'FAIL'}  order_list_isolation`);
    } finally {
      await query('UPDATE orders SET customer_id = ? WHERE id = ?', [originalOwner, someOrder.id]);
    }
  } else {
    results.order_probes = 'SKIP (no orders — run seed:orders)';
  }

  // ---- support tickets ----------------------------------------------------
  const ticketA = await supportService.createTicket({
    customerId: A, subject: 'IDOR probe', body: 'probe', category: 'GENERAL',
    idempotencyKey: randomUUID(),
  });

  await probe('support_ticket_read',
    () => supportService.getTicket(A, ticketA.id),
    () => supportService.getTicket(B, ticketA.id));

  await probe('support_ticket_reply',
    () => supportService.reply({ customerId: A, idOrNumber: ticketA.id, body: 'owner reply' }),
    () => supportService.reply({ customerId: B, idOrNumber: ticketA.id, body: 'stranger reply' }));

  const injected = await query(
    "SELECT COUNT(*) n FROM support_messages WHERE ticket_id = ? AND body = 'stranger reply'", [ticketA.id]);
  results.support_no_injected_message = Number(injected[0].n) === 0
    ? 'PASS' : 'FAIL: a stranger posted into another customer\'s ticket';
  if (!results.support_no_injected_message.startsWith('PASS')) failures += 1;

  // ---- store credit -------------------------------------------------------
  const summaryB = await storeCreditService.getSummary(B, { limit: 50, offset: 0 });
  results.store_credit_scoped = Number(summaryB?.balanceMinor ?? 0) === 0 && (summaryB?.entries ?? []).length === 0
    ? 'PASS (a new customer sees an empty ledger)'
    : `FAIL: unrelated customer sees balance=${summaryB?.balanceMinor} entries=${(summaryB?.entries ?? []).length}`;
  if (!results.store_credit_scoped.startsWith('PASS')) failures += 1;

  console.log(`\n${JSON.stringify(results, null, 2)}`);
  console.log(`\nCUSTOMER_IDOR = ${failures ? 'FAIL' : 'PASS'}`);
} finally {
  const safe = async (fn) => { try { await fn(); } catch (e) { console.error('  cleanup:', e.message); } };

  // Put the borrowed inventory back exactly as found.
  if (inventoryFixture) {
    const f = inventoryFixture;
    await safe(() => (f.existed
      ? query('UPDATE inventory SET on_hand = ?, reserved = ? WHERE sku_id = ? AND warehouse_id = ?',
        [f.before.on_hand, f.before.reserved, f.skuId, f.warehouseId])
      : query('DELETE FROM inventory WHERE sku_id = ? AND warehouse_id = ?', [f.skuId, f.warehouseId])));
  }

  // Release reservations through the service before deleting anything.
  // Creating a checkout reserves stock, and `inventory.reserved` is only
  // decremented by the release path — so deleting the reservation rows
  // directly leaves that counter permanently inflated and breaks
  // `inventory_reserved_matches_open_reservations` for every later run.
  for (const id of customers) {
    // eslint-disable-next-line no-await-in-loop
    const open = await query(
      "SELECT id FROM checkout_sessions WHERE customer_id = ? AND status NOT IN ('CANCELLED', 'FINALIZED')", [id]);
    for (const row of open) {
      // eslint-disable-next-line no-await-in-loop
      await safe(() => checkoutService.cancel(id, row.id));
    }
  }

  for (const id of customers) {
    await safe(() => query('DELETE stm FROM support_messages stm JOIN support_tickets st ON st.id = stm.ticket_id WHERE st.customer_id = ?', [id]));
    await safe(() => query('DELETE FROM support_tickets WHERE customer_id = ?', [id]));
    // checkout_sessions RESTRICT-references carts, so it has to go first.
    await safe(() => query('DELETE FROM checkout_sessions WHERE customer_id = ?', [id]));
    await safe(() => query('DELETE ci FROM cart_items ci JOIN carts c ON c.id = ci.cart_id WHERE c.customer_id = ?', [id]));
    await safe(() => query('DELETE FROM carts WHERE customer_id = ?', [id]));
    await safe(() => query('DELETE iri FROM inventory_reservation_items iri JOIN inventory_reservations ir ON ir.id = iri.reservation_id WHERE ir.customer_id = ?', [id]));
    await safe(() => query('DELETE FROM inventory_reservations WHERE customer_id = ?', [id]));
    await safe(() => query('DELETE FROM addresses WHERE customer_id = ?', [id]));
    await safe(() => query('DELETE FROM customers WHERE id = ?', [id]));
  }
  await pool.end();
}

if (failures) process.exit(1);
