// Database-name portability proof for the fulfillment foundation.
//
// Creates a temporary MySQL database whose name is NOT the configured local
// name, runs the full migration set (including 015) against it, seeds the
// catalog, builds a minimal Order graph, and exercises FulfillmentService
// end-to-end — all bound purely by env.DB_NAME. Drops the temp DB afterwards.
//
// The DB name is overridden BEFORE any src/ import so the pool binds to it.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '..', 'database', 'migrations');

// Matches the `corcotton_db` wildcard in the local grant; still a DIFFERENT
// name from the configured DB. Override via PORTABILITY_DB_NAME.
const TEMP_DB = process.env.PORTABILITY_DB_NAME || 'corcotton7db';
const ORIGINAL_DB = process.env.DB_NAME || 'cor_group';
assert.notEqual(TEMP_DB, ORIGINAL_DB, 'portability test DB must differ from the configured DB');

// Override BEFORE config/env.js is first imported so the pool binds to TEMP_DB
// purely through the environment — the whole point of the test.
process.env.DB_NAME = TEMP_DB;
const { env } = await import('../src/config/env.js');
assert.equal(env.DB_NAME, TEMP_DB);

const admin = await mysql.createConnection({
  host: env.DB_HOST, port: env.DB_PORT, user: env.DB_USER, password: env.DB_PASSWORD, multipleStatements: true,
});

const results = { tempDb: TEMP_DB, configuredDb: ORIGINAL_DB };
let pool;

try {
  await admin.query(`DROP DATABASE IF EXISTS \`${TEMP_DB}\``);
  await admin.query(`CREATE DATABASE \`${TEMP_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await admin.query(`USE \`${TEMP_DB}\``);

  // ---- run every migration, in order, against the temp DB ----
  await admin.query(`CREATE TABLE schema_migrations (
    id INT AUTO_INCREMENT PRIMARY KEY, version VARCHAR(255) NOT NULL, name VARCHAR(255) NOT NULL,
    applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_v (version), UNIQUE KEY uq_n (name)) ENGINE=InnoDB`);
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    await admin.query(sql);
    await admin.query('INSERT INTO schema_migrations (version,name) VALUES (?,?)', [file.split('_')[0], file]);
  }
  results.migrations = { applied: files.length, includes015: files.includes('015_fulfillment_foundation.sql') };
  assert(results.migrations.includes015);

  // migration 015 contains no CREATE DATABASE / USE
  const raw015 = await readFile(path.join(migrationsDir, '015_fulfillment_foundation.sql'), 'utf8');
  assert(!/\bCREATE\s+DATABASE\b/i.test(raw015) && !/^\s*USE\s+/im.test(raw015), 'migration 015 must not pin a database');
  results.migration015EnvPortable = 'PASS';

  // ---- seed catalog into the temp DB (env-driven) ----
  execFileSync(process.execPath, [path.join(__dirname, 'seed.js')], {
    env: { ...process.env, DB_NAME: TEMP_DB }, stdio: 'pipe',
  });

  // ---- exercise the module against the temp DB (pool already env-bound) ----
  ({ pool } = await import('../src/database/connection/pool.js'));
  const { query } = await import('../src/database/connection/pool.js');
  const { fulfillmentService } = await import('../src/modules/fulfillment/service.js');

  const connectedDb = (await query('SELECT DATABASE() AS db'))[0].db;
  assert.equal(connectedDb, TEMP_DB, 'pool must be bound to the temp DB via env only');
  results.connectedDatabase = connectedDb;

  // minimal Order graph
  const sku = (await query(
    `SELECT s.id AS sku_id, s.sku, s.price_minor, v.id AS variant_id, p.id AS product_id, p.name
       FROM skus s JOIN product_variants v ON v.id=s.variant_id JOIN products p ON p.id=v.product_id LIMIT 1`,
  ))[0];
  assert(sku, 'seed did not populate catalog in temp DB');

  const customerId = randomUUID();
  const cartId = randomUUID();
  const reservationId = randomUUID();
  const checkoutId = randomUUID();
  const orderId = randomUUID();
  const price = Number(sku.price_minor);

  await query("INSERT INTO customers (id, brand_id,status) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'), 'ACTIVE')", [customerId]);
  await query('INSERT INTO carts (id, brand_id,customer_id,currency) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?)', [cartId, customerId, 'INR']);
  await query(
    `INSERT INTO inventory_reservations (id, brand_id, customer_id,idempotency_key,request_fingerprint,status,expires_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'), ?,?,?, 'CONSUMED', DATE_ADD(NOW(3), INTERVAL 1 DAY))`,
    [reservationId, customerId, `port:${reservationId}`, '0'.repeat(64)],
  );
  await query(
    `INSERT INTO checkout_sessions (id, brand_id,customer_id,cart_id,inventory_reservation_id,idempotency_key,cart_fingerprint,status,currency,
       subtotal_minor,shipping_minor,total_minor,reservation_expires_at,expires_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,?,?, 'FINALIZED', 'INR', ?, 0, ?, DATE_ADD(NOW(3), INTERVAL 1 DAY), DATE_ADD(NOW(3), INTERVAL 1 DAY))`,
    [checkoutId, customerId, cartId, reservationId, `port:${checkoutId}`, 'f'.repeat(64), price, price],
  );
  const address = { firstName: 'Port', lastName: 'Test', addressLine1: '1 Rd', addressLine2: null, city: 'Delhi', state: 'Delhi', postalCode: '110001', country: 'IN', phone: '9999999999' };
  await query(
    `INSERT INTO orders
      (id,brand_id,order_number,checkout_id,customer_id,inventory_reservation_id,payment_status,payment_mode,currency,
       subtotal_minor,shipping_minor,total_minor,online_paid_minor,cod_due_minor,
       shipping_address_snapshot,shipping_snapshot,finalization_source)
     VALUES (?,(SELECT id FROM brands WHERE slug='corcotton'),?,?,?,?, 'PAID', 'PREPAID', 'INR', ?, 0, ?, ?, 0, ?, ?, 'PORTABILITY_TEST')`,
    [orderId, `COR-PORT-${orderId.slice(0, 8).toUpperCase()}`, checkoutId, customerId, reservationId,
      price, price, price, JSON.stringify(address), JSON.stringify({ serviceLevel: 'STANDARD', providerCode: 'MOCK' })],
  );
  await query(
    `INSERT INTO order_items
      (id,order_id,product_id,variant_id,sku_id,product_name,sku,quantity,unit_price_minor,line_total_minor)
     VALUES (?,?,?,?,?,?,?,1,?,?)`,
    [randomUUID(), orderId, sku.product_id, sku.variant_id, sku.sku_id, sku.name, sku.sku, price, price],
  );

  const invBefore = JSON.stringify(await query('SELECT sku_id,on_hand,reserved FROM inventory ORDER BY sku_id'));
  const f = await fulfillmentService.ensureForOrder(orderId);
  assert.equal(f.orderId, orderId);
  assert.equal(f.type, 'INITIAL');
  assert.equal(f.items.length, 1);
  assert.equal(f.items[0].quantity, 1);
  assert.equal(f.shipments.length, 1);
  assert.equal(f.shipments[0].status, 'DRAFT');
  assert.equal(f.shipments[0].providerCode, null);
  assert.equal(f.readinessStatus, 'BLOCKED');
  assert.equal(f.blockReason, 'MISSING_SHIPPING_METADATA');
  assert.equal(f.financial.codCollectionMinor, 0);
  assert.equal(JSON.stringify(await query('SELECT sku_id,on_hand,reserved FROM inventory ORDER BY sku_id')), invBefore);

  // idempotent under the temp DB too
  const again = await fulfillmentService.ensureForOrder(orderId);
  assert.equal(again.id, f.id);
  assert.equal(Number((await query('SELECT COUNT(*) n FROM fulfillments WHERE order_id=?', [orderId]))[0].n), 1);

  // schema guards resolve via DATABASE(), not a pinned name
  const guardIdx = await query("SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fulfillments' AND INDEX_NAME='uk_fulfillments_initial_order_warehouse'");
  assert.equal(guardIdx.length, 1);
  const guardChk = await query("SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='shipments' AND CONSTRAINT_NAME='chk_shipment_booked_complete'");
  assert.equal(guardChk.length, 1);

  results.fulfillmentScriptsEnvPortable = 'PASS';
  results.databaseNameHardcoding = 0;
  results.status = 'PASS';
} finally {
  if (pool) await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS \`${TEMP_DB}\``);
  await admin.end();
}

results.cleanup = `dropped ${TEMP_DB}`;
console.log(JSON.stringify(results, null, 2));
