import { withTransaction } from '../../database/connection/transaction.js';
import { AppError } from '../../utils/errors.js';
import { warehouseRepository } from './repository.js';
import { companyRepository } from '../company/repository.js';
import { assertPickupContact, normalizeWarehouseContactPatch, pickupContactStatus } from './pickupContact.js';

/** Immutable origin snapshot stored on a fulfillment/shipment at creation. */
export function warehouseSnapshot(warehouse) {
  if (!warehouse) return null;
  return {
    warehouseId: warehouse.id,
    code: warehouse.code,
    name: warehouse.name,
    address: {
      addressLine1: warehouse.address_line1 || null,
      addressLine2: warehouse.address_line2 || null,
      city: warehouse.city || null,
      state: warehouse.state || null,
      postalCode: warehouse.postal_code || null,
      country: warehouse.country || 'IN',
    },
    contact: {
      name: warehouse.contact_name || null,
      phone: warehouse.contact_phone || null,
      phoneAlt: warehouse.contact_phone_alt || null,
      email: warehouse.contact_email || null,
    },
    snapshotAt: new Date().toISOString(),
  };
}

export function warehouseDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    state: row.state,
    postalCode: row.postal_code,
    country: row.country,
    contactName: row.contact_name,
    contactPhone: row.contact_phone,
    contactPhoneAlt: row.contact_phone_alt,
    contactEmail: row.contact_email,
    // Surfaced so the CMS can warn BEFORE an operator reaches Ready for
    // Pickup, rather than only failing at the gate.
    pickupContact: pickupContactStatus(row),
    priority: row.priority,
    isDefault: Boolean(row.is_default),
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export class WarehouseService {
  constructor({ repository = warehouseRepository } = {}) {
    this.repository = repository;
  }

  async list(opts) {
    return (await this.repository.list(opts)).map(warehouseDto);
  }

  async get(id) {
    const row = await this.repository.findById(id);
    if (!row) throw new AppError('WAREHOUSE_NOT_FOUND', 'Warehouse not found.', 404);
    return warehouseDto(row);
  }

  /** The default dispatch-origin warehouse for a company. Discovery authority is `is_default`. */
  async getDefault(brandId = null) {
    const row = await this.repository.findDefault(brandId);
    if (!row) throw new AppError('WAREHOUSE_NO_DEFAULT', 'No default warehouse is configured.', 409);
    return warehouseDto(row);
  }

  async getDefaultRow(brandId = null, connection = null) {
    return this.repository.findDefault(brandId, connection);
  }

  /**
   * Promote `id` to the single default warehouse and keep
   * `company_profile.default_warehouse_id` in sync, atomically. A DISABLED
   * warehouse can never be the default dispatch origin.
   */
  async setDefault(id) {
    return withTransaction(async (connection) => {
      const [rows] = await connection.execute('SELECT id, brand_id, status FROM warehouses WHERE id = ? LIMIT 1 FOR UPDATE', [id]);
      const warehouse = rows[0];
      if (!warehouse) throw new AppError('WAREHOUSE_NOT_FOUND', 'Warehouse not found.', 404);
      if (warehouse.status !== 'ACTIVE') {
        throw new AppError('WAREHOUSE_DISABLED', 'A disabled warehouse cannot be the default dispatch origin.', 409);
      }
      await this.repository.setDefault(connection, warehouse.brand_id, id);
      await companyRepository.setDefaultWarehouse(connection, warehouse.brand_id, id);
      return warehouseDto(await this.repository.findById(id, connection));
    });
  }

  async getRow(id, connection = null) {
    const row = await this.repository.findById(id, connection);
    if (!row) throw new AppError('WAREHOUSE_NOT_FOUND', 'Warehouse not found.', 404);
    return row;
  }

  async create(input) {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{1,31}$/.test(String(input.code || ''))) {
      throw new AppError('VALIDATION_ERROR', 'Warehouse code must be 2-32 chars, alphanumeric and hyphens.', 400);
    }
    return warehouseDto(await this.repository.create(normalizeWarehouseContactPatch(input)));
  }

  async update(id, patch) {
    await this.getRow(id);
    return warehouseDto(await this.repository.update(id, normalizeWarehouseContactPatch(patch)));
  }

  async setStatus(id, status) {
    if (!['ACTIVE', 'DISABLED'].includes(status)) {
      throw new AppError('VALIDATION_ERROR', 'Status must be ACTIVE or DISABLED.', 400);
    }
    const row = await this.getRow(id);
    // A warehouse a pickup agent cannot reach must not be enabled for
    // fulfilment. Failing here tells the operator while they can still fix
    // it, instead of only at the Ready-for-Pickup gate.
    if (status === 'ACTIVE') assertPickupContact(row, 'ACTIVATION');
    if (status === 'DISABLED' && row.is_default) {
      throw new AppError('WAREHOUSE_IS_DEFAULT', 'The default warehouse cannot be disabled. Set another warehouse as default first.', 409);
    }
    return warehouseDto(await this.repository.update(id, { status }));
  }

  async snapshotFor(warehouseId, connection = null) {
    return warehouseSnapshot(await this.repository.findById(warehouseId, connection));
  }
}

export const warehouseService = new WarehouseService();
