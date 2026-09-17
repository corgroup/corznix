import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';
import { AppError } from '../../utils/errors.js';
import { resolveBrandId, defaultBrandId } from '../../utils/defaultBrand.js';

// Owner Delivery (migration 071) — a CORCOTTON-operated last-mile option for
// specific PIN codes, priced per-PIN and injected into the checkout quote as a
// synthetic method after carrier orchestration. Never booked with a carrier.

export const OWNER_DELIVERY_METHOD = 'OWNER_DELIVERY';
export const OWNER_DELIVERY_PROVIDER = 'OWNER';
const PIN_RE = /^\d{6}$/;

const toDto = (r) => ({
  id: r.id,
  name: r.name,
  pincode: r.pincode,
  chargeMinor: Number(r.charge_minor),
  enabled: Boolean(r.enabled),
  notes: r.notes ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class OwnerDeliveryRepository {
  /** Master toggle from shipping_settings. */
  async isMasterEnabled() {
    const rows = await query('SELECT owner_delivery_enabled FROM shipping_settings WHERE id = 1 LIMIT 1');
    return Boolean(rows[0]?.owner_delivery_enabled);
  }

  async setMasterEnabled(enabled) {
    // shipping_settings is a genuine singleton (id = 1); brand_id (migration
    // 082) is only here so the INSERT half of this upsert is valid SQL — the
    // row always already exists, so UPDATE is what actually fires and
    // brand_id is never touched by it. Real per-brand rewiring of this
    // table is deliberately deferred (same boundary as return_policy/
    // cod_settings).
    const brandId = await defaultBrandId();
    await query(
      `INSERT INTO shipping_settings (id, brand_id, owner_delivery_enabled) VALUES (1, ?, ?)
       ON DUPLICATE KEY UPDATE owner_delivery_enabled = VALUES(owner_delivery_enabled), updated_at = NOW(3)`,
      [brandId, enabled ? 1 : 0],
    );
    return this.settings();
  }

  async settings() {
    return { ownerDeliveryEnabled: await this.isMasterEnabled() };
  }

  async listZones(brandId = null) {
    const resolvedBrandId = await resolveBrandId(brandId);
    const rows = await query('SELECT * FROM owner_delivery_zones WHERE brand_id = ? ORDER BY name, pincode', [resolvedBrandId]);
    return rows.map(toDto);
  }

  // Phase 6 security pass (DESIGN.md §5.3) — brandId is now REQUIRED so a
  // cross-brand id can never be read, updated, or deleted; a mismatch 404s
  // exactly like a missing row (never leak existence via 403).
  async zoneById(id, brandId) {
    if (!brandId) throw new AppError('BRAND_REQUIRED', 'brandId is required to look up an Owner Delivery zone.', 500);
    const rows = await query('SELECT * FROM owner_delivery_zones WHERE id = ? AND brand_id = ? LIMIT 1', [id, brandId]);
    return rows[0] ? toDto(rows[0]) : null;
  }

  async createZone({ name, pincode, chargeMinor, enabled = true, notes = null, staffId = null, brandId }) {
    if (!brandId) throw new AppError('BRAND_REQUIRED', 'brandId is required to create an Owner Delivery zone.', 500);
    const clean = String(pincode || '').trim();
    if (!PIN_RE.test(clean)) throw new AppError('VALIDATION_ERROR', 'PIN code must be exactly 6 digits.', 400);
    if (!name || !name.trim()) throw new AppError('VALIDATION_ERROR', 'A zone name is required.', 400);
    const charge = Math.max(0, Math.round(Number(chargeMinor) || 0));
    if (!Number.isFinite(charge) || charge > 100_000_000) throw new AppError('VALIDATION_ERROR', 'Charge must be a non-negative amount.', 400);
    const id = randomUUID();
    try {
      await query(
        `INSERT INTO owner_delivery_zones (id, brand_id, name, pincode, charge_minor, enabled, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, brandId, name.trim(), clean, charge, enabled ? 1 : 0, notes ? String(notes).slice(0, 255) : null, staffId],
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw new AppError('OWNER_DELIVERY_PIN_EXISTS', `PIN ${clean} already has an Owner Delivery zone.`, 409);
      throw err;
    }
    return this.zoneById(id, brandId);
  }

  async updateZone(id, brandId, patch) {
    const existing = await this.zoneById(id, brandId);
    if (!existing) throw new AppError('OWNER_DELIVERY_ZONE_NOT_FOUND', 'Zone not found.', 404);
    const fields = [];
    const params = [];
    if (patch.name !== undefined) {
      if (!patch.name.trim()) throw new AppError('VALIDATION_ERROR', 'A zone name is required.', 400);
      fields.push('name = ?'); params.push(patch.name.trim());
    }
    if (patch.pincode !== undefined) {
      const clean = String(patch.pincode).trim();
      if (!PIN_RE.test(clean)) throw new AppError('VALIDATION_ERROR', 'PIN code must be exactly 6 digits.', 400);
      fields.push('pincode = ?'); params.push(clean);
    }
    if (patch.chargeMinor !== undefined) {
      const charge = Math.max(0, Math.round(Number(patch.chargeMinor) || 0));
      fields.push('charge_minor = ?'); params.push(charge);
    }
    if (patch.enabled !== undefined) { fields.push('enabled = ?'); params.push(patch.enabled ? 1 : 0); }
    if (patch.notes !== undefined) { fields.push('notes = ?'); params.push(patch.notes ? String(patch.notes).slice(0, 255) : null); }
    if (!fields.length) return existing;
    params.push(id, brandId);
    try {
      await query(`UPDATE owner_delivery_zones SET ${fields.join(', ')} WHERE id = ? AND brand_id = ?`, params);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw new AppError('OWNER_DELIVERY_PIN_EXISTS', 'Another zone already uses that PIN.', 409);
      throw err;
    }
    return this.zoneById(id, brandId);
  }

  async deleteZone(id, brandId) {
    if (!brandId) throw new AppError('BRAND_REQUIRED', 'brandId is required to delete an Owner Delivery zone.', 500);
    const res = await query('DELETE FROM owner_delivery_zones WHERE id = ? AND brand_id = ?', [id, brandId]);
    if (!res.affectedRows) throw new AppError('OWNER_DELIVERY_ZONE_NOT_FOUND', 'Zone not found.', 404);
    return { deleted: true };
  }

  /**
   * The Owner Delivery offer for a destination PIN, or null. Honours the
   * master toggle and the per-zone enabled flag.
   */
  async matchForPincode(pincode, brandId = null) {
    const clean = String(pincode || '').trim();
    if (!PIN_RE.test(clean)) return null;
    if (!(await this.isMasterEnabled())) return null;
    const resolvedBrandId = await resolveBrandId(brandId);
    const rows = await query(
      'SELECT * FROM owner_delivery_zones WHERE brand_id = ? AND pincode = ? AND enabled = 1 LIMIT 1',
      [resolvedBrandId, clean],
    );
    if (!rows[0]) return null;
    return { zoneId: rows[0].id, zoneName: rows[0].name, pincode: clean, chargeMinor: Number(rows[0].charge_minor) };
  }
}

export const ownerDeliveryRepository = new OwnerDeliveryRepository();

/**
 * Build the synthetic OWNER_DELIVERY method for a quote result. `issuedAt` /
 * `expiresAt` come from the surrounding carrier quote so selection + snapshot
 * TTL behave identically.
 */
export function buildOwnerDeliveryMethod(match, { issuedAt, expiresAt }) {
  const option = {
    quoteId: randomUUID(),
    providerCode: OWNER_DELIVERY_PROVIDER,
    providerName: 'CORCOTTON',
    providerServiceCode: 'OWNER_DELIVERY',
    serviceLevel: OWNER_DELIVERY_METHOD,
    name: 'Owner Delivery',
    rateMinor: match.chargeMinor,
    chargeMinor: match.chargeMinor,
    providerRateMinor: match.chargeMinor,
    actualLogisticsCostMinor: 0,
    surchargeMinor: 0,
    pricingMode: 'OWNER_DELIVERY_FLAT',
    estimatedDeliveryAt: null,
    estimatedDays: null,
    codSupported: false,
    prepaidSupported: true,
    providerPriority: 0,
    minCodAmountMinor: null,
    maxCodAmountMinor: null,
    customerVisible: true,
    rateSource: 'OWNER_DELIVERY_CONFIG',
    ownerDeliveryZone: match.zoneName,
    quoteIssuedAt: issuedAt,
    quoteExpiresAt: expiresAt,
  };
  return { code: OWNER_DELIVERY_METHOD, name: 'Owner Delivery', options: [option] };
}
