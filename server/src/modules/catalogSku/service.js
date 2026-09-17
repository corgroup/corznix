// Phase 1B — backend authority for canonical SKU identity.
//
// The frontend NEVER decides the final SKU. It picks components (product type,
// fit, colour, design code, size); the server resolves those to codes,
// generates + validates the canonical string, guards uniqueness and identity
// locking, and persists. All identity mutations are transactional (brief §31).
//
// Multi-company (implementation/multi-company/DESIGN.md §4.1, Phase 3):
// every method takes `brandId` (from `req.brandId`) and threads it through
// to masterRepository + the raw skus queries here — admin-only module, no
// storefront caller, so it's required rather than optional.
import { randomUUID } from 'node:crypto';
import { AppError } from '../../utils/errors.js';
import { query } from '../../database/connection/pool.js';
import { withTransaction } from '../../database/connection/transaction.js';
import { StaffAuditRepository } from '../staff/repositories.js';
import { catalogSkuMasterRepository as master } from './masterRepository.js';
import { generateSku, sizeCodeStatus, SIZE_RULES, normalizeCode, validateDesignCode } from './generator.js';

const auditRepo = new StaffAuditRepository();
const audit = (actor, entry) => auditRepo.log({
  staffUserId: actor?.id || null, actorEmail: actor?.email || null,
  ipAddress: actor?.ip || null, requestId: actor?.requestId || null, ...entry,
}).catch(() => {});

const exec = async (tx, sql, params) => {
  if (tx) { const [r] = await tx.execute(sql, params); return r; }
  return query(sql, params);
};

function firstError(errors) {
  return new AppError(errors[0].code || 'SKU_IDENTITY_INCOMPLETE', errors[0].message, 422, { errors });
}

export class CatalogSkuService {
  // ---- master options (brief §29 — GET canonical SKU options) ----------
  async getOptions(brandId) {
    const [productTypes, fits, colors] = await Promise.all([
      master.productTypeCodes(brandId), master.fitCodes(brandId), master.colorCodes(brandId),
    ]);
    const dto = (r) => ({
      id: r.id, label: r.label, code: r.code, status: r.status,
      usageCount: Number(r.usage_count || 0),
      ...(r.sizeFamily ? { sizeFamily: r.sizeFamily } : {}),
      ...(r.displayHex !== undefined ? { displayHex: r.displayHex } : {}),
    });
    return {
      productTypes: productTypes.map(dto),
      fits: fits.map(dto),
      colors: colors.map(dto),
      sizeRules: SIZE_RULES,
      brandCode: 'COR',
    };
  }

  // ---- operator-created master codes (governed) -----------------------
  async createProductTypeCode(input, actor, brandId) {
    let row;
    try {
      row = await master.createProductTypeCode({ ...input, brandId });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        throw new AppError('CODE_ALREADY_EXISTS', 'A product type with that code or label already exists.', 409);
      }
      if (err.code === 'ER_CHECK_CONSTRAINT_VIOLATED') {
        throw new AppError('VALIDATION_ERROR', 'Code must be 2–8 uppercase letters or digits.', 422);
      }
      throw err;
    }
    await audit(actor, {
      action: 'SKU_TYPE_CODE_CREATED', resourceType: 'catalog_product_type_code', resourceId: row.id,
      metadata: { label: row.label, code: row.code, sizeFamily: row.size_family },
    });
    return { id: row.id, label: row.label, code: row.code, sizeFamily: row.size_family, status: row.status };
  }

  async createFitCode(input, actor, brandId) {
    let row;
    try {
      row = await master.createFitCode({ ...input, brandId });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        throw new AppError('CODE_ALREADY_EXISTS', 'A fit with that code or label already exists.', 409);
      }
      if (err.code === 'ER_CHECK_CONSTRAINT_VIOLATED') {
        throw new AppError('VALIDATION_ERROR', 'Code must be 1–8 uppercase letters or digits.', 422);
      }
      throw err;
    }
    await audit(actor, {
      action: 'SKU_FIT_CODE_CREATED', resourceType: 'catalog_fit_code', resourceId: row.id,
      metadata: { label: row.label, code: row.code },
    });
    return { id: row.id, label: row.label, code: row.code, status: row.status };
  }

  // ---- resolve the fixed identity components for a variant -------------
  // Returns { codes, missing[], sizeFamily, product, variant }.
  #componentsFromContext(ctx) {
    const missing = [];
    if (!ctx.product_type_code_id) missing.push({ field: 'productType', code: 'NEEDS_PRODUCT_TYPE_MAPPING', message: `Product type "${ctx.product_type || '—'}" does not yet have an approved SKU code.` });
    if (!ctx.fit_code_id) missing.push({ field: 'fit', code: 'NEEDS_FIT_MAPPING', message: 'Choose a fit with an approved SKU code.' });
    if (!ctx.color_code_id) missing.push({ field: 'color', code: 'NEEDS_COLOR', message: 'Choose a colour before generating this SKU.' });
    const dc = validateDesignCode(ctx.design_code);
    if (!dc.ok) missing.push({ field: 'designCode', code: dc.code, message: dc.code === 'MISSING_DESIGN_CODE' ? 'Enter a design code for this variant.' : dc.message });
    return {
      codes: {
        productTypeCode: ctx.product_type_code || null,
        fitCode: ctx.fit_code || null,
        colorCode: ctx.color_code || null,
        designCode: dc.ok ? dc.value : null,
      },
      sizeFamily: ctx.size_family || null,
      missing,
    };
  }

  // ---- preview (brief §18 — POST SKU preview) --------------------------
  async previewForVariant(variantId, { sizeCode } = {}, brandId) {
    const ctx = await master.variantIdentityContext(variantId, brandId);
    if (!ctx) throw new AppError('VARIANT_NOT_FOUND', 'Variant not found.', 404);
    const { codes, sizeFamily, missing } = this.#componentsFromContext(ctx);

    const size = normalizeCode(sizeCode);
    if (!size) {
      return { status: 'INCOMPLETE', preview: null, missing: [...missing, { field: 'size', code: 'MISSING_SIZE', message: 'Choose a size.' }], sizeFamily, sizeRule: SIZE_RULES[sizeFamily] || null, components: codes };
    }
    const gen = generateSku({ ...codes, sizeCode: size, sizeFamily });
    if (!gen.ok) {
      return { status: 'INCOMPLETE', preview: null, missing: gen.errors, sizeFamily, sizeRule: SIZE_RULES[sizeFamily] || null, components: codes };
    }
    const owner = await master.skuStringOwner(gen.sku, brandId);
    if (owner) {
      return {
        status: 'DUPLICATE', preview: gen.sku, missing: [],
        duplicateOf: { productId: owner.product_id, productName: owner.product_name, color: owner.color_name, size: owner.size },
        sizeFamily, components: gen.parts,
      };
    }
    return { status: 'READY', preview: gen.sku, missing: [], sizeFamily, components: gen.parts };
  }

  // ---- lock state (brief §20/§45) -------------------------------------
  async skuLockState(skuId, brandId) {
    const ctx = await master.skuIdentityContext(skuId, brandId);
    if (!ctx) throw new AppError('SKU_NOT_FOUND', 'SKU not found.', 404);
    const withHistory = await master.skusWithOperationalHistory([skuId]);
    const hasHistory = withHistory.has(skuId);
    return {
      skuId,
      sku: ctx.sku,
      kind: ctx.sku_kind,
      identityLocked: hasHistory,
      reason: hasHistory
        ? 'This SKU has order or inventory history and its identity is locked.'
        : null,
      canonicalReady: ctx.sku_kind === 'CANONICAL',
    };
  }

  // ---- create a canonical SKU from components (brief §14/§16/§42) ------
  // Called by adminCatalog.createSku. `input` = { size, priceMinor, salePriceMinor?, currency?, status?, displayOrder? }.
  async createCanonicalSku(productId, variantId, input, actor, brandId) {
    const ctx = await master.variantIdentityContext(variantId, brandId);
    if (!ctx) throw new AppError('VARIANT_NOT_FOUND', 'Variant not found.', 404);
    if (ctx.product_id !== productId) throw new AppError('VARIANT_NOT_FOUND', 'Variant does not belong to this product.', 404);

    const { codes, sizeFamily, missing } = this.#componentsFromContext(ctx);
    const size = normalizeCode(input.size);
    const gen = generateSku({ ...codes, sizeCode: size, sizeFamily });
    if (!gen.ok) throw firstError([...missing, ...gen.errors].length ? [...missing, ...gen.errors] : gen.errors);

    const skuId = randomUUID();
    try {
      await withTransaction(async (tx) => {
        // canonical-identity preflight (brief §16) — a friendly duplicate
        // check before the DB unique guard fires.
        const owner = await master.skuStringOwner(gen.sku, brandId);
        if (owner) throw new AppError('SKU_ALREADY_EXISTS', 'This SKU already exists.', 409);
        await tx.execute(
          `INSERT INTO skus (id, variant_id, brand_id, sku, sku_kind, size, weight_grams, status, price_minor, sale_price_minor, currency, display_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'CANONICAL', ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))`,
          [skuId, variantId, brandId, gen.sku, size, input.weightGrams ?? null, input.status || 'ACTIVE', input.priceMinor,
            input.salePriceMinor ?? null, input.currency || 'INR', input.displayOrder ?? 0],
        );
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (err.code === 'ER_DUP_ENTRY') throw new AppError('SKU_ALREADY_EXISTS', 'This SKU already exists.', 409);
      throw err;
    }
    await audit(actor, {
      action: 'SKU_CREATED', resourceType: 'sku', resourceId: skuId,
      metadata: { productId, variantId, sku: gen.sku, kind: 'CANONICAL', components: gen.parts },
    });
    return skuId;
  }

  // ---- pre-operational canonical identity edit (brief §21) ------------
  // Regenerate a CANONICAL sku's string after a size change, only if it has
  // no operational history.
  async updateCanonicalSkuSize(skuId, newSize, actor, brandId) {
    const ctx = await master.skuIdentityContext(skuId, brandId);
    if (!ctx) throw new AppError('SKU_NOT_FOUND', 'SKU not found.', 404);
    if (ctx.sku_kind !== 'CANONICAL') {
      throw new AppError('SKU_IDENTITY_LEGACY', 'This SKU is a legacy code — complete its canonical setup instead of editing the size.', 422);
    }
    const history = await master.skusWithOperationalHistory([skuId]);
    if (history.has(skuId)) {
      throw new AppError('SKU_IDENTITY_LOCKED', 'This SKU has order or inventory history and its identity is locked.', 422);
    }
    const { codes, sizeFamily } = this.#componentsFromContext(ctx);
    const size = normalizeCode(newSize);
    const gen = generateSku({ ...codes, sizeCode: size, sizeFamily });
    if (!gen.ok) throw firstError(gen.errors);
    if (gen.sku === ctx.sku) return skuId;
    try {
      await withTransaction(async (tx) => {
        const owner = await master.skuStringOwner(gen.sku, brandId, skuId);
        if (owner) throw new AppError('SKU_ALREADY_EXISTS', 'This SKU already exists.', 409);
        await tx.execute('UPDATE skus SET sku = ?, size = ?, updated_at = NOW(3) WHERE id = ? AND brand_id = ?', [gen.sku, size, skuId, brandId]);
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (err.code === 'ER_DUP_ENTRY') throw new AppError('SKU_ALREADY_EXISTS', 'This SKU already exists.', 409);
      throw err;
    }
    await audit(actor, {
      action: 'SKU_IDENTITY_CONFIGURED', resourceType: 'sku', resourceId: skuId,
      metadata: { from: ctx.sku, to: gen.sku, field: 'size' },
    });
    return skuId;
  }

  // ---- regenerate a variant's non-locked CANONICAL skus after a
  //      colour / design / product-type / fit change (brief §21). Skips
  //      LEGACY skus and any CANONICAL sku with operational history.
  //      Runs inside the caller's transaction.
  async regenerateVariantCanonicalSkus(tx, variantId, actor, brandId) {
    // Read the identity through the SAME transaction that just changed it.
    // On a fresh pool connection this could not see the uncommitted
    // `UPDATE product_variants SET design_code = ...`, so it rebuilt the SKU
    // from the OLD identity, found the result identical, and reported nothing
    // to do — a recode returned 200 while every SKU silently kept the code it
    // was supposed to stop having.
    const ctx = await master.variantIdentityContext(variantId, brandId, tx);
    if (!ctx) return { regenerated: 0, blocked: [] };
    const { codes, sizeFamily, missing } = this.#componentsFromContext(ctx);

    const skus = await exec(tx, "SELECT id, sku, size FROM skus WHERE variant_id = ? AND sku_kind = 'CANONICAL'", [variantId]);
    if (skus.length === 0) return { regenerated: 0, blocked: [] };
    const history = await master.skusWithOperationalHistory(skus.map((s) => s.id));

    if (missing.length && skus.some((s) => !history.has(s.id))) {
      throw new AppError(missing[0].code, missing[0].message, 422, { errors: missing });
    }

    let regenerated = 0;
    const blocked = [];
    for (const s of skus) {
      if (history.has(s.id)) { blocked.push({ skuId: s.id, sku: s.sku, reason: 'OPERATIONAL_HISTORY' }); continue; }
      const gen = generateSku({ ...codes, sizeCode: s.size, sizeFamily });
      if (!gen.ok) throw firstError(gen.errors);
      if (gen.sku === s.sku) continue;
      const [dupe] = await exec(tx, 'SELECT id FROM skus WHERE sku = ? AND brand_id = ? AND id <> ? LIMIT 1', [gen.sku, brandId, s.id]);
      if (dupe) throw new AppError('SKU_ALREADY_EXISTS', `Regenerating this variant would collide with an existing SKU (${gen.sku}).`, 409);
      await tx.execute('UPDATE skus SET sku = ?, updated_at = NOW(3) WHERE id = ?', [gen.sku, s.id]);
      await audit(actor, { action: 'SKU_IDENTITY_CONFIGURED', resourceType: 'sku', resourceId: s.id, metadata: { from: s.sku, to: gen.sku, cause: 'VARIANT_IDENTITY_CHANGE' } });
      regenerated += 1;
    }
    if (blocked.length) {
      throw new AppError('SKU_IDENTITY_LOCKED', `This variant has ${blocked.length} SKU(s) with order or inventory history — their identity is locked and cannot be regenerated.`, 422, { blocked });
    }
    return { regenerated, blocked };
  }

  // ---- Phase 1B legacy migration READINESS (dry run — brief §23) ------
  async migrationReadiness(brandId) {
    const rows = await master.legacySkuRows(brandId);
    const withHistory = await master.skusWithOperationalHistory(rows.map((r) => r.sku_id));
    const targetSeen = new Map(); // targetSku -> first sku_id that claimed it

    const records = rows.map((r) => {
      const reasons = [];
      const { codes, sizeFamily } = this.#componentsFromContext(r);
      if (!r.product_type_code_id) reasons.push('NEEDS_PRODUCT_TYPE_MAPPING');
      if (!r.fit_code_id) reasons.push('NEEDS_FIT_MAPPING');
      if (!r.color_code_id) reasons.push('NEEDS_COLOR_MAPPING');
      if (!r.design_code) reasons.push('NEEDS_DESIGN_CODE');
      if (sizeFamily && sizeCodeStatus(sizeFamily, r.size) !== 'APPROVED') reasons.push('NEEDS_SIZE_POLICY_DECISION');

      let targetSku = null;
      if (reasons.length === 0) {
        const gen = generateSku({ ...codes, sizeCode: r.size, sizeFamily });
        if (gen.ok) {
          targetSku = gen.sku;
          if (targetSeen.has(targetSku)) reasons.push('DUPLICATE_TARGET');
          else targetSeen.set(targetSku, r.sku_id);
        } else {
          reasons.push(gen.errors[0].code);
        }
      }

      const status = reasons.length === 0 ? 'READY' : reasons[0];
      return {
        currentSku: r.sku,
        skuId: r.sku_id,
        product: r.product_name,
        variant: r.color_name || '(no colour)',
        size: r.size,
        hasOperationalHistory: withHistory.has(r.sku_id),
        productTypeMapping: r.product_type_code || null,
        fitMapping: r.fit_code || null,
        colorMapping: r.color_code || null,
        designMapping: r.design_code || null,
        targetSku,
        status,
        blockReasons: reasons,
      };
    });

    const count = (pred) => records.filter(pred).length;
    return {
      legacySkuCount: records.length,
      ready: count((r) => r.status === 'READY'),
      blocked: count((r) => r.status !== 'READY'),
      byReason: {
        NEEDS_PRODUCT_TYPE_MAPPING: count((r) => r.blockReasons.includes('NEEDS_PRODUCT_TYPE_MAPPING')),
        NEEDS_FIT_MAPPING: count((r) => r.blockReasons.includes('NEEDS_FIT_MAPPING')),
        NEEDS_COLOR_MAPPING: count((r) => r.blockReasons.includes('NEEDS_COLOR_MAPPING')),
        NEEDS_DESIGN_CODE: count((r) => r.blockReasons.includes('NEEDS_DESIGN_CODE')),
        NEEDS_SIZE_POLICY_DECISION: count((r) => r.blockReasons.includes('NEEDS_SIZE_POLICY_DECISION')),
        DUPLICATE_TARGET: count((r) => r.blockReasons.includes('DUPLICATE_TARGET')),
      },
      records,
    };
  }
}

export const catalogSkuService = new CatalogSkuService();
export default catalogSkuService;
