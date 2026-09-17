import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';

const exec = async (connection, sql, params = []) =>
  (connection ? (await connection.execute(sql, params))[0] : query(sql, params));

// Data access for the provider-neutral REVERSE shipment seam (§67-70).
export class ReverseShipmentRepository {
  byRequest(connection, returnRequestId, { lock = false } = {}) {
    return exec(connection,
      `SELECT * FROM return_shipments WHERE return_request_id = ? LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
      [returnRequestId]).then((r) => r[0] || null);
  }

  lockById(connection, id) {
    return exec(connection, 'SELECT * FROM return_shipments WHERE id = ? LIMIT 1 FOR UPDATE', [id])
      .then((r) => r[0] || null);
  }

  /** Match a provider reference against either the provider shipment id or the reverse AWB. */
  byProviderRef(connection, ref) {
    return exec(connection,
      'SELECT * FROM return_shipments WHERE provider_shipment_id = ? OR reverse_awb = ? LIMIT 1', [ref, ref])
      .then((r) => r[0] || null);
  }

  async insert(connection, s) {
    const id = randomUUID();
    await exec(connection,
      `INSERT INTO return_shipments
        (id, return_request_id, shipment_number, status, pickup_address_snapshot_json,
         destination_warehouse_id, destination_warehouse_snapshot_json)
       VALUES (?, ?, ?, 'PENDING', ?, ?, ?)`,
      [id, s.returnRequestId, s.shipmentNumber, JSON.stringify(s.pickupAddressSnapshot),
        s.destinationWarehouseId, JSON.stringify(s.destinationWarehouseSnapshot)]);
    return exec(connection, 'SELECT * FROM return_shipments WHERE id = ?', [id]).then((r) => r[0]);
  }

  update(connection, id, fields) {
    const sets = ['updated_at = NOW(3)'];
    const params = [];
    for (const [col, val] of Object.entries(fields)) { sets.push(`${col} = ?`); params.push(val); }
    params.push(id);
    return exec(connection, `UPDATE return_shipments SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  attemptByKey(connection, key) {
    return exec(connection, 'SELECT * FROM return_shipment_booking_attempts WHERE idempotency_key = ? LIMIT 1', [key])
      .then((r) => r[0] || null);
  }

  async createAttempt(connection, a) {
    const id = randomUUID();
    await exec(connection,
      `INSERT INTO return_shipment_booking_attempts
        (id, return_shipment_id, provider_code, idempotency_key, request_hash, status)
       VALUES (?, ?, ?, ?, ?, 'PENDING')`,
      [id, a.returnShipmentId, a.providerCode, a.idempotencyKey, a.requestHash]);
    return exec(connection, 'SELECT * FROM return_shipment_booking_attempts WHERE id = ?', [id]).then((r) => r[0]);
  }

  completeAttempt(connection, id, { status, providerShipmentId = null, reverseAwb = null, failureCode = null, response = null }) {
    return exec(connection,
      `UPDATE return_shipment_booking_attempts
          SET status = ?, provider_shipment_id = ?, reverse_awb = ?, failure_code = ?, response_json = ?, completed_at = NOW(3)
        WHERE id = ?`,
      [status, providerShipmentId, reverseAwb, failureCode, response ? JSON.stringify(response) : null, id]);
  }

  eventByKey(connection, providerCode, providerEventKey) {
    return exec(connection,
      'SELECT * FROM return_shipment_events WHERE provider_code = ? AND provider_event_key = ? LIMIT 1',
      [providerCode, providerEventKey]).then((r) => r[0] || null);
  }

  async insertEvent(connection, e) {
    const id = randomUUID();
    await exec(connection,
      `INSERT INTO return_shipment_events
        (id, return_shipment_id, source, provider_code, provider_event_key, provider_status,
         normalized_status, occurred_at, location_text, remarks, applied)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, e.returnShipmentId, e.source || 'MOCK', e.providerCode, e.providerEventKey, e.providerStatus || null,
        e.normalizedStatus, e.occurredAt, e.locationText || null, e.remarks || null, e.applied ? 1 : 0]);
    return id;
  }

  events(returnShipmentId) {
    return query(
      `SELECT source, provider_status, normalized_status, occurred_at, location_text, remarks, applied
         FROM return_shipment_events WHERE return_shipment_id = ? ORDER BY occurred_at, received_at`,
      [returnShipmentId]);
  }

  // ---- webhook inbox (§79) -------------------------------------------
  webhookByDedupe(connection, providerCode, providerEventId) {
    return exec(connection,
      'SELECT * FROM return_shipment_webhook_events WHERE provider_code = ? AND provider_event_id = ? LIMIT 1',
      [providerCode, providerEventId]).then((r) => r[0] || null);
  }

  insertWebhook(connection, w) {
    return exec(connection,
      `INSERT INTO return_shipment_webhook_events
        (id, provider_code, provider_event_id, return_shipment_id, signature_valid, raw_payload_json,
         normalized_status, status, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [w.id, w.providerCode, w.providerEventId, w.returnShipmentId, w.signatureValid ? 1 : 0,
        JSON.stringify(w.rawPayload), w.normalizedStatus || null, w.status, w.error || null]);
  }

  markWebhook(connection, id, { status, error = null }) {
    return exec(connection,
      'UPDATE return_shipment_webhook_events SET status = ?, error = ?, processed_at = NOW(3) WHERE id = ?',
      [status, error, id]);
  }
}

export const reverseShipmentRepository = new ReverseShipmentRepository();
