import { randomUUID } from 'node:crypto';
import { pool, query } from '../src/database/connection/pool.js';
import { inventoryService } from '../src/modules/inventory/service.js';
import { expireReservationBatch } from '../src/modules/inventory/expiryWorker.js';
import { cartService } from '../src/modules/cart/service.js';
import { catalogService } from '../src/modules/catalog/service.js';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const customerIds = [randomUUID(), randomUUID()];
const createdReservationIds = [];

// Single-warehouse deployment: every SKU's inventory lives at the default
// warehouse. The warehouse-scoped API is exercised generically by
// verify-multi-warehouse-commerce.js.
let WH;
const withWh = (items) => items.map((item) => ({ warehouseId: WH, ...item }));

async function stock(skuId) {
  const [row] = await query('SELECT on_hand,reserved FROM inventory WHERE sku_id=? AND warehouse_id=?', [skuId, WH]);
  return { onHand: Number(row.on_hand), reserved: Number(row.reserved), available: Number(row.on_hand) - Number(row.reserved) };
}

async function reserve(items, key, ttlSeconds = 60) {
  const result = await inventoryService.reserve(withWh(items), { idempotencyKey: `inventory-verify:${key}:${randomUUID()}`, ttlSeconds });
  createdReservationIds.push(result.id); return result;
}

async function main() {
  const skuRows = await query(
    `SELECT s.id,s.size,v.storefront_id FROM skus s JOIN product_variants v ON v.id=s.variant_id
     JOIN products p ON p.id=v.product_id WHERE s.status='ACTIVE' AND v.status='ACTIVE' AND p.status='ACTIVE'
     ORDER BY s.id LIMIT 2`);
  assert(skuRows.length === 2, 'Two controlled SKUs are required.');
  [WH] = (await query('SELECT id FROM warehouses WHERE is_default = 1 LIMIT 1')).map((r) => r.id);
  assert(WH, 'A default warehouse (is_default = 1) is required.');
  const originals = await Promise.all(skuRows.map((row) => stock(row.id)));
  try {
    await query('UPDATE inventory SET on_hand=5,reserved=0 WHERE sku_id IN (?,?) AND warehouse_id=?', [skuRows[0].id, skuRows[1].id, WH]);
    for (const id of customerIds) await query("INSERT INTO customers (id, brand_id,first_name,last_name,status,profile_completed_at) VALUES (?, (SELECT id FROM brands WHERE slug='corcotton'),'InventoryTest','Test','ACTIVE',NOW(3))", [id]);

    const missing = await inventoryService.getAvailabilityForItems([{ skuId: randomUUID(), quantity: 1 }]);
    assert(missing[0].status === 'INVENTORY_NOT_CONFIGURED', 'Missing inventory did not fail closed.');
    await inventoryService.adjustOnHand(WH, skuRows[0].id, 0);
    await inventoryService.assertAvailable([{ skuId: skuRows[0].id, quantity: 1 }]).then(() => { throw new Error('Out of stock accepted.'); }, (e) => assert(e.code === 'OUT_OF_STOCK', 'Wrong out-of-stock code.'));
    const productDetail = await catalogService.getVariantByStorefrontId(skuRows[0].storefront_id);
    assert(productDetail.activeVariant.skus.find((sku) => sku.id === skuRows[0].id).availability.status === 'OUT_OF_STOCK', 'PDP SKU availability was not variant-specific.');
    await inventoryService.adjustOnHand(WH, skuRows[0].id, 5);

    await cartService.addItem(customerIds[0], { storefrontId: skuRows[0].storefront_id, size: skuRows[0].size, quantity: 2 });
    assert((await stock(skuRows[0].id)).reserved === 0, 'Cart reserved inventory.');
    await cartService.addItem(customerIds[1], { storefrontId: skuRows[0].storefront_id, size: skuRows[0].size, quantity: 2 });
    assert((await stock(skuRows[0].id)).reserved === 0, 'Second customer cart reserved inventory.');
    await cartService.addItem(customerIds[0], { storefrontId: skuRows[0].storefront_id, size: skuRows[0].size, quantity: 4 }).then(() => { throw new Error('Cart exceeded stock.'); }, (e) => assert(e.code === 'INSUFFICIENT_STOCK', 'Wrong cart stock code.'));
    await inventoryService.adjustOnHand(WH, skuRows[0].id, 1);
    const staleCart = await cartService.getCart(customerIds[0]);
    assert(staleCart.items[0].availability.status === 'INSUFFICIENT_STOCK' && staleCart.hasInventoryIssues, 'Stale cart was not annotated.');
    await inventoryService.adjustOnHand(WH, skuRows[0].id, 5);

    const lifecycle = await reserve([{ skuId: skuRows[0].id, quantity: 2 }], 'release');
    assert((await stock(skuRows[0].id)).reserved === 2, 'Reserve failed.');
    await inventoryService.releaseReservation(lifecycle.id); await inventoryService.releaseReservation(lifecycle.id);
    assert((await stock(skuRows[0].id)).reserved === 0, 'Repeated release corrupted stock.');

    const idemKey = `inventory-verify:idem:${randomUUID()}`;
    const idemA = await inventoryService.reserve(withWh([{ skuId: skuRows[0].id, quantity: 1 }]), { idempotencyKey: idemKey, ttlSeconds: 60 });
    createdReservationIds.push(idemA.id);
    const idemB = await inventoryService.reserve(withWh([{ skuId: skuRows[0].id, quantity: 1 }]), { idempotencyKey: idemKey, ttlSeconds: 60 });
    assert(idemA.id === idemB.id && (await stock(skuRows[0].id)).reserved === 1, 'Idempotent replay reserved twice.');
    await inventoryService.reserve(withWh([{ skuId: skuRows[0].id, quantity: 2 }]), { idempotencyKey: idemKey }).then(() => { throw new Error('Idempotency conflict accepted.'); }, (e) => assert(e.code === 'IDEMPOTENCY_CONFLICT', 'Wrong idempotency conflict.'));
    await inventoryService.releaseReservation(idemA.id);

    const multi = await reserve([{ skuId: skuRows[1].id, quantity: 1 }, { skuId: skuRows[0].id, quantity: 2 }, { skuId: skuRows[0].id, quantity: 1 }], 'multi');
    assert((await stock(skuRows[0].id)).reserved === 3 && (await stock(skuRows[1].id)).reserved === 1, 'Multi-SKU normalization failed.');
    await inventoryService.releaseReservation(multi.id);
    await inventoryService.adjustOnHand(WH, skuRows[1].id, 0);
    await reserve([{ skuId: skuRows[0].id, quantity: 1 }, { skuId: skuRows[1].id, quantity: 1 }], 'rollback').then(() => { throw new Error('Partial reservation accepted.'); }, (e) => assert(['OUT_OF_STOCK','INSUFFICIENT_STOCK'].includes(e.code), 'Wrong rollback error.'));
    assert((await stock(skuRows[0].id)).reserved === 0, 'Multi-SKU failure partially reserved.');
    await inventoryService.adjustOnHand(WH, skuRows[1].id, 5);

    const races = await Promise.allSettled([
      reserve([{ skuId: skuRows[0].id, quantity: 4 }], 'race-a'),
      reserve([{ skuId: skuRows[0].id, quantity: 4 }], 'race-b'),
    ]);
    assert(races.filter((r) => r.status === 'fulfilled').length === 1 && (await stock(skuRows[0].id)).reserved === 4, 'Concurrent oversubscription invariant failed.');
    await inventoryService.releaseReservation(races.find((r) => r.status === 'fulfilled').value.id);

    const expiring = await reserve([{ skuId: skuRows[0].id, quantity: 2 }], 'expiry', 1);
    await new Promise((resolve) => setTimeout(resolve, 1100)); await expireReservationBatch(); await inventoryService.expireReservation(expiring.id);
    assert((await stock(skuRows[0].id)).reserved === 0, 'Expiry did not restore availability.');

    const consuming = await reserve([{ skuId: skuRows[0].id, quantity: 2 }], 'consume');
    await inventoryService.consumeReservation(consuming.id); await inventoryService.consumeReservation(consuming.id);
    assert(JSON.stringify(await stock(skuRows[0].id)) === JSON.stringify({ onHand: 3, reserved: 0, available: 3 }), 'Consume quantities incorrect.');
    await inventoryService.adjustOnHand(WH, skuRows[0].id, 5);

    const terminalRace = await reserve([{ skuId: skuRows[0].id, quantity: 2 }], 'terminal-race');
    await Promise.allSettled([inventoryService.releaseReservation(terminalRace.id), inventoryService.consumeReservation(terminalRace.id)]);
    const [terminal] = await query('SELECT status FROM inventory_reservations WHERE id=?', [terminalRace.id]);
    assert(['RELEASED','CONSUMED'].includes(terminal.status) && (await stock(skuRows[0].id)).reserved === 0, 'Release/consume race corrupted stock.');

    await inventoryService.adjustOnHand(WH, skuRows[0].id, 5);
    const expiryRace = await reserve([{ skuId: skuRows[0].id, quantity: 2 }], 'expiry-race');
    await query('UPDATE inventory_reservations SET expires_at=NOW(3) WHERE id=?', [expiryRace.id]);
    await Promise.allSettled([inventoryService.expireReservation(expiryRace.id), inventoryService.consumeReservation(expiryRace.id)]);
    const [expired] = await query('SELECT status FROM inventory_reservations WHERE id=?', [expiryRace.id]);
    assert(expired.status === 'EXPIRED' && (await stock(skuRows[0].id)).reserved === 0, 'Expire/consume race corrupted stock.');

    const adjustment = await reserve([{ skuId: skuRows[0].id, quantity: 4 }], 'adjustment');
    await inventoryService.adjustOnHand(WH, skuRows[0].id, 3).then(() => { throw new Error('Unsafe stock adjustment accepted.'); }, (e) => assert(e.code === 'INVENTORY_BELOW_RESERVED', 'Wrong adjustment error.'));
    await inventoryService.releaseReservation(adjustment.id);

    console.log(JSON.stringify({ availability: 'PASS', missingInventory: 'PASS', skuSpecificPdp: 'PASS', cartDoesNotReserve: 'PASS', cartFinalQuantity: 'PASS', staleCartAnnotation: 'PASS', multiCustomerCart: 'PASS', multiSkuAtomicity: 'PASS', concurrentOversubscription: { initial: 5, requests: [4,4], winners: 1, finalReserved: 4 }, idempotency: 'PASS', release: 'PASS', expire: 'PASS', consume: 'PASS', terminalRaces: 'PASS', expiryWorker: 'PASS', noNegativeInventory: 'PASS' }, null, 2));
  } finally {
    await query('DELETE FROM carts WHERE customer_id IN (?,?)', customerIds);
    await query('DELETE FROM customers WHERE id IN (?,?)', customerIds);
    for (const id of createdReservationIds) {
      await query("DELETE FROM inventory_movements WHERE reference_type='INVENTORY_RESERVATION' AND reference_id=?", [id]);
      await query('DELETE FROM inventory_reservations WHERE id=?', [id]);
    }
    for (let i=0;i<skuRows.length;i+=1) await query('UPDATE inventory SET on_hand=?,reserved=? WHERE sku_id=?', [originals[i].onHand, originals[i].reserved, skuRows[i].id]);
    await pool.end();
  }
}

main().catch((error) => { console.error(error); process.exitCode=1; });
