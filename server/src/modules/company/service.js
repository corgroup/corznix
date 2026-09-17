import { companyRepository } from './repository.js';
import { defaultBrandId } from '../../utils/defaultBrand.js';

const profileDto = (row) => (row ? {
  id: row.brand_id,
  legalName: row.legal_name,
  tradeName: row.trade_name,
  constitution: row.constitution,
  gstin: row.gstin,
  gstRegistrationType: row.gst_registration_type,
  gstStateCode: row.gst_state_code,
  gstEffectiveFrom: row.gst_effective_from,
  principalAddress: {
    addressLine1: row.principal_address_line1,
    addressLine2: row.principal_address_line2,
    city: row.principal_city,
    state: row.principal_state,
    postalCode: row.principal_postal_code,
    country: row.principal_country,
  },
  ownerStaffUserId: row.owner_staff_user_id,
  defaultWarehouseId: row.default_warehouse_id,
} : null);

/**
 * Company identity + ownership. Small on purpose: 8C-2 only needs "who is the
 * owner" for the single-SUPER_ADMIN governance rule; the legal/tax snapshot is
 * consumed by invoice issuance in 8C-4.
 *
 * Multi-company (DESIGN.md §3.4) — Phase 5. This module's own "owner"
 * governance rule (§8C-2: at least one active SUPER_ADMIN who is THE
 * company owner) predates multi-company and was never a per-request,
 * per-brand concept — every call site is a global staff-governance check
 * (staff/service.js), not something with a real req.brandId in scope. Every
 * method here defaults to the `is_default` brand (utils/defaultBrand.js)
 * rather than requiring an explicit brandId thread through 4 governance
 * call sites for a rule that has always meant "the primary company" —
 * pass one explicitly if a real caller ever needs a specific brand's owner.
 */
export class CompanyService {
  constructor({ repository = companyRepository } = {}) {
    this.repository = repository;
  }

  async getProfile(brandId = null, connection = null) {
    return profileDto(await this.repository.getProfile(brandId || await defaultBrandId(), connection));
  }

  async getOwner(brandId = null) {
    return this.repository.getOwner(brandId || await defaultBrandId());
  }

  /** @returns {Promise<boolean>} whether `staffUserId` is the current company owner. */
  async isOwner(staffUserId, brandId = null) {
    if (!staffUserId) return false;
    const profile = await this.repository.getProfile(brandId || await defaultBrandId());
    return Boolean(profile && profile.owner_staff_user_id && profile.owner_staff_user_id === staffUserId);
  }

  /** True once a company owner is set — the bootstrap SUPER_ADMIN window is closed. */
  async hasOwner(brandId = null) {
    const profile = await this.repository.getProfile(brandId || await defaultBrandId());
    return Boolean(profile && profile.owner_staff_user_id);
  }

  /**
   * Update the legal-identity fields for one company (Settings > Company
   * Profile, Phase 6). Takes camelCase input matching `profileDto`'s own
   * shape — never touches owner/default-warehouse (those have their own
   * dedicated, transaction-aware flows).
   */
  async updateProfile(brandId, patch) {
    if (!brandId) throw new Error('brandId is required to update a company profile.');
    const fields = {};
    if (patch.legalName !== undefined) fields.legal_name = patch.legalName;
    if (patch.tradeName !== undefined) fields.trade_name = patch.tradeName;
    if (patch.constitution !== undefined) fields.constitution = patch.constitution;
    if (patch.gstin !== undefined) fields.gstin = patch.gstin;
    if (patch.gstRegistrationType !== undefined) fields.gst_registration_type = patch.gstRegistrationType;
    if (patch.gstStateCode !== undefined) fields.gst_state_code = patch.gstStateCode;
    if (patch.gstEffectiveFrom !== undefined) fields.gst_effective_from = patch.gstEffectiveFrom;
    const addr = patch.principalAddress || {};
    if (addr.addressLine1 !== undefined) fields.principal_address_line1 = addr.addressLine1;
    if (addr.addressLine2 !== undefined) fields.principal_address_line2 = addr.addressLine2;
    if (addr.city !== undefined) fields.principal_city = addr.city;
    if (addr.state !== undefined) fields.principal_state = addr.state;
    if (addr.postalCode !== undefined) fields.principal_postal_code = addr.postalCode;
    if (addr.country !== undefined) fields.principal_country = addr.country;
    return profileDto(await this.repository.updateProfile(brandId, fields));
  }
}

export const companyService = new CompanyService();
