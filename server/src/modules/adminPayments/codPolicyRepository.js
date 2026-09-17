import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';
import { AppError } from '../../utils/errors.js';
import { resolveBrandId } from '../../utils/defaultBrand.js';

// Read/write side of the COD policy that `paymentEligibility/evaluator.js` has
// always read. Nothing here re-decides eligibility — the evaluator remains the
// single place that does — this module only lets an operator change the inputs
// it consults, which until now had no interface at all. That is why COD was
// permanently unavailable in production: `cod_settings` defaults to 0 and there
// was no way to turn it on.

const PIN_RE = /^\d{6}$/;
const bool = (value) => (Number(value) ? 1 : 0);

const pinDto = (row) => ({
  postalCode: row.postal_code,
  deliveryBlocked: Boolean(Number(row.delivery_blocked)),
  codBlocked: Boolean(Number(row.cod_blocked)),
  partialCodBlocked: Boolean(Number(row.partial_cod_blocked)),
  riskLevel: row.risk_level || null,
  updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
});

const valueRuleDto = (row) => ({
  id: row.id,
  minAmountMinor: Number(row.min_amount_minor),
  maxAmountMinor: row.max_amount_minor == null ? null : Number(row.max_amount_minor),
  codAllowed: Boolean(Number(row.cod_allowed)),
  partialCodMode: row.partial_cod_mode,
  advanceType: row.advance_type || null,
  advanceValue: row.advance_value == null ? null : Number(row.advance_value),
  advanceNonRefundable: Boolean(Number(row.advance_non_refundable)),
  status: row.status,
});

export class CodPolicyRepository {
  async settings(brandId = null) {
    const brand = await resolveBrandId(brandId);
    const row = (await query('SELECT * FROM cod_settings WHERE brand_id = ? LIMIT 1', [brand]))[0] || null;
    return {
      // An absent row is not "enabled by default" — the evaluator treats it as
      // off, and so does this.
      configured: Boolean(row),
      codEnabled: Boolean(row && Number(row.cod_enabled)),
      partialCodEnabled: Boolean(row && Number(row.partial_cod_enabled)),
      advanceNonRefundableEnabled: Boolean(row && Number(row.advance_non_refundable_enabled)),
      valueRuleBasis: row?.value_rule_basis || 'CHECKOUT_TOTAL',
      updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
    };
  }

  async setSettings(brandId, { codEnabled, partialCodEnabled, advanceNonRefundableEnabled }) {
    const brand = await resolveBrandId(brandId);
    const current = await this.settings(brand);
    const next = {
      codEnabled: codEnabled === undefined ? current.codEnabled : Boolean(codEnabled),
      partialCodEnabled: partialCodEnabled === undefined ? current.partialCodEnabled : Boolean(partialCodEnabled),
      advanceNonRefundableEnabled: advanceNonRefundableEnabled === undefined
        ? current.advanceNonRefundableEnabled : Boolean(advanceNonRefundableEnabled),
    };
    await query(
      `INSERT INTO cod_settings (id, brand_id, cod_enabled, partial_cod_enabled, advance_non_refundable_enabled)
       VALUES (1, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE cod_enabled = VALUES(cod_enabled), partial_cod_enabled = VALUES(partial_cod_enabled),
         advance_non_refundable_enabled = VALUES(advance_non_refundable_enabled), updated_at = NOW(3)`,
      [brand, bool(next.codEnabled), bool(next.partialCodEnabled), bool(next.advanceNonRefundableEnabled)],
    );
    return this.settings(brand);
  }

  /**
   * Every value rule, newest band first. The evaluator only applies a rule when
   * EXACTLY ONE active rule matches the order total, so overlapping bands
   * silently disable COD — `overlaps` names them rather than leaving an
   * operator to wonder why COD never appears.
   */
  async valueRules(brandId = null) {
    const brand = await resolveBrandId(brandId);
    const rows = await query('SELECT * FROM cod_value_rules WHERE brand_id = ? ORDER BY min_amount_minor ASC', [brand]);
    const active = rows.filter((r) => r.status === 'ACTIVE').map(valueRuleDto);
    const overlaps = [];
    for (let i = 0; i < active.length; i += 1) {
      for (let j = i + 1; j < active.length; j += 1) {
        const a = active[i];
        const b = active[j];
        const aMax = a.maxAmountMinor ?? Number.MAX_SAFE_INTEGER;
        const bMax = b.maxAmountMinor ?? Number.MAX_SAFE_INTEGER;
        if (a.minAmountMinor <= bMax && b.minAmountMinor <= aMax) overlaps.push([a.id, b.id]);
      }
    }
    return { rules: rows.map(valueRuleDto), overlaps };
  }

  // Brand-scoped like every other read here. Without the scope this both
  // listed another company's PIN restrictions and — because the route passes
  // brandId first — silently dropped the search term, since the id landed in
  // the options slot and every option fell back to its default.
  async pins(brandId, { search = '', limit = 50, offset = 0 } = {}) {
    const brand = await resolveBrandId(brandId);
    const clean = String(search || '').replace(/\D/g, '').slice(0, 6);
    const where = clean ? 'WHERE brand_id = ? AND postal_code LIKE ?' : 'WHERE brand_id = ?';
    const params = clean ? [brand, `${clean}%`] : [brand];
    const [{ total }] = await query(`SELECT COUNT(*) total FROM pin_payment_restrictions ${where}`, params);
    const rows = await query(
      `SELECT * FROM pin_payment_restrictions ${where} ORDER BY postal_code ASC LIMIT ? OFFSET ?`,
      [...params, Number(limit), Number(offset)],
    );
    return { total: Number(total), pins: rows.map(pinDto) };
  }

  async pin(brandId, postalCode) {
    const brand = await resolveBrandId(brandId);
    const row = (await query('SELECT * FROM pin_payment_restrictions WHERE brand_id = ? AND postal_code = ? LIMIT 1', [brand, postalCode]))[0];
    return row ? pinDto(row) : null;
  }

  async setPin(brandId, postalCode, { deliveryBlocked, codBlocked, partialCodBlocked, riskLevel }) {
    const pin = String(postalCode || '').trim();
    if (!PIN_RE.test(pin)) throw new AppError('VALIDATION_ERROR', 'PIN code must be exactly 6 digits.', 400);
    const brand = await resolveBrandId(brandId);
    const current = await this.pin(brand, pin);
    const next = {
      deliveryBlocked: deliveryBlocked === undefined ? Boolean(current?.deliveryBlocked) : Boolean(deliveryBlocked),
      codBlocked: codBlocked === undefined ? Boolean(current?.codBlocked) : Boolean(codBlocked),
      partialCodBlocked: partialCodBlocked === undefined ? Boolean(current?.partialCodBlocked) : Boolean(partialCodBlocked),
      riskLevel: riskLevel === undefined ? (current?.riskLevel ?? null) : (riskLevel || null),
    };
    await query(
      `INSERT INTO pin_payment_restrictions (brand_id, postal_code, delivery_blocked, cod_blocked, partial_cod_blocked, risk_level)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE delivery_blocked = VALUES(delivery_blocked), cod_blocked = VALUES(cod_blocked),
         partial_cod_blocked = VALUES(partial_cod_blocked), risk_level = VALUES(risk_level), updated_at = NOW(3)`,
      [brand, pin, bool(next.deliveryBlocked), bool(next.codBlocked), bool(next.partialCodBlocked), next.riskLevel],
    );
    return this.pin(brand, pin);
  }

  async removePin(brandId, postalCode) {
    const brand = await resolveBrandId(brandId);
    const res = await query('DELETE FROM pin_payment_restrictions WHERE brand_id = ? AND postal_code = ?', [brand, postalCode]);
    if (!res.affectedRows) throw new AppError('PIN_RESTRICTION_NOT_FOUND', 'No restriction stored for that PIN.', 404);
    return { deleted: true };
  }

  /**
   * A COD value band. The evaluator applies a rule only when EXACTLY ONE
   * active band matches the order total, so a band that overlaps another
   * disables COD for the overlap rather than "winning" — `valueRules()`
   * reports overlaps for that reason.
   */
  async upsertValueRule(brandId, { id = null, minAmountMinor, maxAmountMinor = null, codAllowed = true, partialCodMode = 'DISABLED', advanceType = null, advanceValue = null, advanceNonRefundable = false, status = 'ACTIVE' }) {
    // Validation runs BEFORE the brand lookup: an invalid band should not cost
    // a database round-trip, and it keeps this rule set testable without one.
    const min = Math.max(0, Math.round(Number(minAmountMinor)));
    const max = maxAmountMinor === null || maxAmountMinor === undefined || maxAmountMinor === '' ? null : Math.round(Number(maxAmountMinor));
    if (!Number.isFinite(min)) throw new AppError('VALIDATION_ERROR', 'A minimum amount is required.', 400);
    if (max !== null && (!Number.isFinite(max) || max < min)) throw new AppError('VALIDATION_ERROR', 'The maximum must be at or above the minimum.', 400);
    if (!['DISABLED', 'AVAILABLE', 'REQUIRED'].includes(partialCodMode)) throw new AppError('VALIDATION_ERROR', 'Unknown partial COD mode.', 400);
    // The evaluator has no decision for "partial offered, full COD blocked":
    // PARTIAL_COD_OPTIONAL means the customer may choose partial OR full, so
    // with full blocked it falls through to PREPAID_ONLY — while still
    // computing a split and still accepting a PARTIAL_COD selection. That
    // combination tells the customer one thing and the API another, so it is
    // refused here rather than left to produce it. "Partial only" is
    // expressible, and is what REQUIRED means.
    if (partialCodMode === 'AVAILABLE' && !codAllowed) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Partial COD set to "offered" needs full COD allowed as the alternative. To offer only partial COD in this band, set it to "required" instead.',
        400,
      );
    }
    if (partialCodMode !== 'DISABLED') {
      if (!['FIXED', 'PERCENTAGE'].includes(advanceType)) throw new AppError('VALIDATION_ERROR', 'Partial COD needs an advance type of FIXED or PERCENTAGE.', 400);
      const value = Math.round(Number(advanceValue));
      if (!Number.isFinite(value) || value <= 0) throw new AppError('VALIDATION_ERROR', 'The advance amount must be greater than zero.', 400);
      if (advanceType === 'PERCENTAGE' && (value < 1 || value > 10000)) throw new AppError('VALIDATION_ERROR', 'A percentage advance is in basis points, 1 to 10000.', 400);
    }
    const brand = await resolveBrandId(brandId);
    const ruleId = id || randomUUID();
    await query(
      `INSERT INTO cod_value_rules (id, brand_id, min_amount_minor, max_amount_minor, cod_allowed, partial_cod_mode, advance_type, advance_value, advance_non_refundable, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE min_amount_minor = VALUES(min_amount_minor), max_amount_minor = VALUES(max_amount_minor),
         cod_allowed = VALUES(cod_allowed), partial_cod_mode = VALUES(partial_cod_mode), advance_type = VALUES(advance_type),
         advance_value = VALUES(advance_value), advance_non_refundable = VALUES(advance_non_refundable),
         status = VALUES(status), updated_at = NOW(3)`,
      [ruleId, brand, min, max, bool(codAllowed), partialCodMode,
        partialCodMode === 'DISABLED' ? null : advanceType,
        partialCodMode === 'DISABLED' ? null : Math.round(Number(advanceValue)),
        partialCodMode === 'DISABLED' ? 0 : bool(advanceNonRefundable),
        ['ACTIVE', 'ARCHIVED'].includes(status) ? status : 'ACTIVE'],
    );
    const rows = await query('SELECT * FROM cod_value_rules WHERE id = ? AND brand_id = ? LIMIT 1', [ruleId, brand]);
    return rows[0] ? valueRuleDto(rows[0]) : null;
  }

  async archiveValueRule(brandId, id) {
    const brand = await resolveBrandId(brandId);
    const res = await query("UPDATE cod_value_rules SET status = 'ARCHIVED', updated_at = NOW(3) WHERE id = ? AND brand_id = ?", [id, brand]);
    if (!res.affectedRows) throw new AppError('COD_VALUE_RULE_NOT_FOUND', 'Value rule not found.', 404);
    return { archived: true };
  }

  /**
   * The RTO risk rule for a risk level. The evaluator refuses COD outright
   * when the order's risk level has no ACTIVE rule, so this is not optional
   * configuration — without at least an UNKNOWN rule, COD can never appear.
   */
  async setRiskRule(brandId, riskLevel, { action, status = 'ACTIVE' }) {
    if (!['LOW', 'MEDIUM', 'HIGH', 'UNKNOWN', 'CUSTOM'].includes(riskLevel)) throw new AppError('VALIDATION_ERROR', 'Unknown risk level.', 400);
    if (!['ALLOW_FULL_COD', 'REQUIRE_PARTIAL_COD', 'PREPAID_ONLY'].includes(action)) throw new AppError('VALIDATION_ERROR', 'Unknown risk action.', 400);
    const brand = await resolveBrandId(brandId);
    await query(
      `INSERT INTO rto_risk_rules (risk_level, brand_id, action, status) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE action = VALUES(action), status = VALUES(status), updated_at = NOW(3)`,
      [riskLevel, brand, action, ['ACTIVE', 'ARCHIVED'].includes(status) ? status : 'ACTIVE'],
    );
    const rows = await query('SELECT * FROM rto_risk_rules WHERE risk_level = ? AND brand_id = ? LIMIT 1', [riskLevel, brand]);
    return rows[0] ? { riskLevel: rows[0].risk_level, action: rows[0].action, status: rows[0].status } : null;
  }

  async riskRules(brandId = null) {
    const brand = await resolveBrandId(brandId);
    const rows = await query('SELECT * FROM rto_risk_rules WHERE brand_id = ? ORDER BY risk_level ASC', [brand]);
    return rows.map((r) => ({ riskLevel: r.risk_level, action: r.action, status: r.status }));
  }

  /**
   * Why COD is or is not reachable right now, from configuration alone. The
   * evaluator also consults the carrier's per-PIN COD flag and the order total,
   * which are per-order facts — so this reports what an operator can fix, and
   * says plainly that it is not the whole answer.
   */
  async readiness(brandId = null) {
    const brand = await resolveBrandId(brandId);
    const [settings, { rules, overlaps }, risks] = await Promise.all([
      this.settings(brand), this.valueRules(brand), this.riskRules(brand),
    ]);
    const activeRules = rules.filter((r) => r.status === 'ACTIVE');
    const blockers = [];
    if (!settings.codEnabled) blockers.push({ code: 'GLOBAL_COD_DISABLED', detail: 'COD is switched off for the whole store.' });
    if (!activeRules.length) blockers.push({ code: 'NO_ACTIVE_VALUE_RULE', detail: 'No active order-value band allows COD, so no order can qualify.' });
    if (!activeRules.some((r) => r.codAllowed)) blockers.push({ code: 'NO_VALUE_RULE_ALLOWS_COD', detail: 'Every active order-value band has COD switched off.' });
    if (overlaps.length) blockers.push({ code: 'VALUE_RULES_OVERLAP', detail: 'Two active bands cover the same amount. The evaluator applies a rule only when exactly one matches, so COD is refused for amounts in the overlap.' });
    if (!risks.some((r) => r.status === 'ACTIVE')) blockers.push({ code: 'RTO_POLICY_NOT_CONFIGURED', detail: 'No active RTO risk rule. COD is refused when the order\'s risk level has no rule.' });
    return {
      codReachable: blockers.length === 0,
      blockers,
      note: 'Configuration only. The carrier\'s own per-PIN COD flag and the order total are decided per order and are not visible here.',
    };
  }
}

export const codPolicyRepository = new CodPolicyRepository();
