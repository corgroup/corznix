import { AppError } from '../../utils/errors.js';
import { query } from '../../database/connection/pool.js';
import { gstStateFor } from '../../utils/gstStateCodes.js';
import { companyRepository } from '../company/repository.js';
import { taxRepository } from './repository.js';
import { normaliseRateBands, pickRateBand, splitInclusive } from './rateBands.js';

const exec = async (c, sql, p = []) => (c ? await c.execute(sql, p) : [await query(sql, p)])[0];

// Missing / non-effective / conflicting tax configuration BLOCKS invoice
// issuance. It never silently becomes zero tax.
export const TAX_STATUS = Object.freeze({ READY: 'READY', INCOMPLETE: 'INCOMPLETE', AMBIGUOUS: 'AMBIGUOUS' });

export class TaxProfileService {
  constructor({ repository = taxRepository } = {}) { this.repository = repository; }
  list(brandId) { return this.repository.list(brandId); }
  // Multi-company (DESIGN.md §5.3 security checklist) — a cross-brand fetch
  // 404s exactly like a missing one, never leaking existence.
  async get(id, brandId) {
    const p = await this.repository.get(id);
    if (!p || (brandId && p.brand_id !== brandId)) throw new AppError('TAX_PROFILE_NOT_FOUND', 'Tax profile not found.', 404);
    return p;
  }
  // A profile has one GST rate, or price bands (migration 113). With bands,
  // gst_rate_bps holds the first band's rate so the NOT NULL column stays true.
  async create(input) {
    const bands = normaliseRateBands(input.rateBands);
    const gstRateBps = bands?.length ? bands[0].gstRateBps : input.gstRateBps;
    if (!Number.isInteger(gstRateBps) || gstRateBps < 0) throw new AppError('TAX_PROFILE_INVALID', 'GST rate must be a non-negative integer (basis points).', 400);
    const created = await this.repository.create({ ...input, gstRateBps });
    if (bands?.length) await this.repository.replaceBands(created.id, bands);
    return this.repository.get(created.id);
  }
  async update(id, fields) {
    const bands = normaliseRateBands(fields.rateBands);
    const { rateBands, ...patch } = fields; // eslint-disable-line no-unused-vars
    if (bands?.length) patch.gstRateBps = bands[0].gstRateBps;
    if (bands !== undefined) await this.repository.replaceBands(id, bands);
    return this.repository.update(id, patch);
  }
  assignProduct(productId, taxProfileId, staffId) { return this.repository.assignProduct(productId, taxProfileId, staffId); }
  unassignProduct(productId) { return this.repository.unassignProduct(productId); }
  configurationGaps(brandId) { return this.repository.configurationGaps(brandId); }
}

export class TaxResolutionService {
  constructor({ repository = taxRepository } = {}) { this.repository = repository; }

  /**
   * Resolve every order line to an effective tax profile as of the order's
   * placement date. @returns { status, lines, missing }.
   */
  async resolveForOrder(connection, orderId) {
    const [order] = await exec(connection, 'SELECT id, placed_at FROM orders WHERE id = ? LIMIT 1', [orderId]);
    if (!order) throw new AppError('ORDER_NOT_FOUND', 'Order not found.', 404);
    const onDate = new Date(order.placed_at).toISOString().slice(0, 10);
    const items = await exec(connection, 'SELECT id, product_id, sku, product_name, quantity FROM order_items WHERE order_id = ? ORDER BY id', [orderId]);

    const lines = [];
    const missing = [];
    let ambiguous = false;

    const asDate = (v) => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
    for (const it of items) {
      const profile = await this.repository.profileForProduct(connection, it.product_id);
      if (!profile) { missing.push({ sku: it.sku, productName: it.product_name, reason: 'NO_TAX_PROFILE' }); continue; }
      const from = asDate(profile.effective_from);
      const to = asDate(profile.effective_to);
      const effective = from <= onDate && (to == null || to >= onDate) && profile.status === 'ACTIVE';
      if (!effective) { missing.push({ sku: it.sku, productName: it.product_name, reason: 'TAX_PROFILE_NOT_EFFECTIVE' }); continue; }
      const conflicts = await this.repository.activeForHsnOnDate(connection, profile.hsn_sac, onDate);
      if (conflicts.length > 1) ambiguous = true;
      // The rate itself is picked in TaxCalculationService from each line's net
      // per-piece value; bands (if any) travel with the line.
      const rateBands = await this.repository.bandsForProfile(connection, profile.id);
      lines.push({
        orderItemId: it.id, sku: it.sku, productName: it.product_name, quantity: Number(it.quantity),
        taxProfileId: profile.id, hsn: profile.hsn_sac, gstRateBps: Number(profile.gst_rate_bps), rateBands, taxability: profile.taxability,
      });
    }

    if (ambiguous) return { status: TAX_STATUS.AMBIGUOUS, lines, missing };
    if (missing.length) return { status: TAX_STATUS.INCOMPLETE, lines, missing };
    return { status: TAX_STATUS.READY, lines, missing: [] };
  }
}

const ZERO_TAX = new Set(['EXEMPT', 'NIL_RATED', 'ZERO_RATED']);

export class TaxCalculationService {
  constructor({ company = companyRepository } = {}) { this.company = company; }

  /**
   * Store prices are GST-inclusive. Each line's net amount (its gross less its
   * share of any order discount) is what the customer pays for it, so GST is
   * taken OUT of that amount at the rate its profile gives for the per-piece
   * value — it used to be added on top, and the invoice never matched the
   * amount paid.
   *
   * @param resolvedLines from TaxResolutionService (profile rate, bands, quantity, taxability)
   * @param netByLine     map orderItemId -> GST-inclusive net minor units
   * @param shippingAddress buyer address snapshot (place of supply)
   * Final accounting treatment is for the company's CA to confirm.
   */
  async compute(connection, resolvedLines, netByLine, shippingAddress, brandId) {
    const profile = await this.company.getProfile(brandId, connection);
    const supplierStateCode = profile?.gst_state_code || '09'; // CORCOTTON: Uttar Pradesh / 09
    // Place of supply for goods delivered = the delivery state. Every Indian
    // state resolves (it used to recognise only Uttar Pradesh spellings);
    // an unknown state is treated as inter-state (IGST), as before.
    const place = gstStateFor(shippingAddress?.state);
    const intraState = Boolean(place) && place.code === supplierStateCode;

    let cgst = 0; let sgst = 0; let igst = 0; let taxableTotal = 0;
    const items = resolvedLines.map((l) => {
      const net = Math.round(Number(netByLine[l.orderItemId] || 0));
      const quantity = Math.max(1, Number(l.quantity) || 1);
      const zero = ZERO_TAX.has(l.taxability);
      const picked = zero
        ? { gstRateBps: Number(l.gstRateBps) || 0, band: null }
        : pickRateBand({ gstRateBps: l.gstRateBps, bands: l.rateBands }, Math.round(net / quantity));
      const { taxableMinor, taxMinor } = zero ? { taxableMinor: net, taxMinor: 0 } : splitInclusive(net, picked.gstRateBps);
      let lc = 0; let ls = 0; let li = 0;
      if (taxMinor > 0) {
        if (intraState) { lc = Math.floor(taxMinor / 2); ls = taxMinor - lc; } else { li = taxMinor; }
      }
      cgst += lc; sgst += ls; igst += li; taxableTotal += taxableMinor;
      return {
        ...l,
        gstRateBps: picked.gstRateBps,
        rateBand: picked.band ? { maxUnitTaxableMinor: picked.band.maxUnitTaxableMinor, gstRateBps: picked.band.gstRateBps } : null,
        taxableMinor, taxMinor, cgstMinor: lc, sgstMinor: ls, igstMinor: li, totalMinor: net,
      };
    });
    return {
      intraState,
      supplierStateCode,
      placeOfSupply: place ? { state: place.name, code: place.code } : (shippingAddress?.state ? { state: String(shippingAddress.state), code: null } : null),
      taxableMinor: taxableTotal, cgstMinor: cgst, sgstMinor: sgst, igstMinor: igst, items,
    };
  }
}

export const taxProfileService = new TaxProfileService();
export const taxResolutionService = new TaxResolutionService();
export const taxCalculationService = new TaxCalculationService();
