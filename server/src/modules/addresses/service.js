// NEW module (Wave 5). Backend is the validation/authorization authority
// (migration brief §57/§59) — the frontend's own form validation is UX
// only, never trusted here.
import { withTransaction } from '../../database/connection/transaction.js';
import { AppError } from '../../utils/errors.js';
import { normalizePhone } from '../../utils/normalize.js';
import { AddressRepository } from './repositories.js';

// No postal zone 0: a PIN starting with 0 is certainly invalid.
const PIN_CODE_RE = /^[1-9]\d{5}$/;

export class AddressService {
  constructor({ addressRepository = new AddressRepository() } = {}) {
    this.addressRepository = addressRepository;
  }

  async list(customerId) {
    return this.addressRepository.findForCustomer(customerId);
  }

  // Ownership check happens here, once, for every read/write path that
  // takes an addressId — never trust a client-supplied customerId
  // (migration brief §59).
  async getOwned(customerId, addressId) {
    const address = await this.addressRepository.findById(addressId);
    if (!address || address.customer_id !== customerId) {
      throw new AppError('ADDRESS_NOT_FOUND', 'Address not found.', 404);
    }
    return address;
  }

  validate(input) {
    const normalizedPhone = normalizePhone(input.phone);
    if (!normalizedPhone) {
      throw new AppError('VALIDATION_ERROR', 'Enter a valid 10-digit Indian mobile number.', 400);
    }
    if (!PIN_CODE_RE.test(String(input.postalCode || ''))) {
      throw new AppError('VALIDATION_ERROR', 'Enter a valid 6-digit PIN code.', 400);
    }
    if (!input.firstName?.trim() || !input.lastName?.trim() || !input.addressLine1?.trim() || !input.city?.trim() || !input.state?.trim()) {
      throw new AppError('VALIDATION_ERROR', 'Please fill in all required address fields.', 400);
    }
    return normalizedPhone;
  }

  async create(customerId, input) {
    this.validate(input);
    const existingCount = await this.addressRepository.countForCustomer(customerId);
    // First address a customer ever adds is always the default — never
    // leave a customer with zero default address (migration brief §58).
    const isDefault = existingCount === 0 || Boolean(input.isDefault);

    if (isDefault) {
      return withTransaction(async (connection) => {
        await this.addressRepository.clearDefaultForCustomer(connection, customerId);
        await connection.execute(
          `INSERT INTO addresses (id, customer_id, type, first_name, last_name, phone, address_line1, address_line2, city, district, state, postal_code, country, is_default, created_at, updated_at)
           VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'IN', 1, NOW(), NOW())`,
          [customerId, input.type || 'SHIPPING', input.firstName.trim(), input.lastName.trim(), input.phone, input.addressLine1.trim(), input.addressLine2?.trim() || null, input.city.trim(), input.district?.trim() || null, input.state.trim(), input.postalCode]
        );
        const [rows] = await connection.execute('SELECT * FROM addresses WHERE customer_id = ? ORDER BY created_at DESC LIMIT 1', [customerId]);
        return rows[0];
      });
    }

    return this.addressRepository.create({
      customerId,
      type: input.type || 'SHIPPING',
      firstName: input.firstName.trim(),
      lastName: input.lastName.trim(),
      phone: input.phone,
      addressLine1: input.addressLine1.trim(),
      addressLine2: input.addressLine2?.trim() || null,
      city: input.city.trim(),
      district: input.district?.trim() || null,
      state: input.state.trim(),
      postalCode: input.postalCode,
      isDefault: false,
    });
  }

  async update(customerId, addressId, input) {
    await this.getOwned(customerId, addressId);
    this.validate({ ...input, firstName: input.firstName, lastName: input.lastName, addressLine1: input.addressLine1, city: input.city, state: input.state, postalCode: input.postalCode, phone: input.phone });

    if (input.isDefault) {
      return withTransaction(async (connection) => {
        await this.addressRepository.clearDefaultForCustomer(connection, customerId);
        await connection.execute(
          `UPDATE addresses SET type = ?, first_name = ?, last_name = ?, phone = ?, address_line1 = ?, address_line2 = ?, city = ?, district = ?, state = ?, postal_code = ?, is_default = 1, updated_at = NOW() WHERE id = ?`,
          [input.type || 'SHIPPING', input.firstName.trim(), input.lastName.trim(), input.phone, input.addressLine1.trim(), input.addressLine2?.trim() || null, input.city.trim(), input.district?.trim() || null, input.state.trim(), input.postalCode, addressId]
        );
        const [rows] = await connection.execute('SELECT * FROM addresses WHERE id = ? LIMIT 1', [addressId]);
        return rows[0];
      });
    }

    return this.addressRepository.update(addressId, {
      type: input.type || 'SHIPPING',
      first_name: input.firstName.trim(),
      last_name: input.lastName.trim(),
      phone: input.phone,
      address_line1: input.addressLine1.trim(),
      address_line2: input.addressLine2?.trim() || null,
      city: input.city.trim(),
      district: input.district?.trim() || null,
      state: input.state.trim(),
      postal_code: input.postalCode,
    });
  }

  async setDefault(customerId, addressId) {
    await this.getOwned(customerId, addressId);
    return withTransaction(async (connection) => {
      await this.addressRepository.clearDefaultForCustomer(connection, customerId);
      await this.addressRepository.setDefault(connection, addressId);
      const [rows] = await connection.execute('SELECT * FROM addresses WHERE id = ? LIMIT 1', [addressId]);
      return rows[0];
    });
  }

  // Deleting the default address hands the default flag to the
  // next-most-recently-updated remaining address, if any — never leaves
  // the customer in a state with multiple addresses but no default
  // (migration brief §58's "deleting default behaves predictably").
  async delete(customerId, addressId) {
    const address = await this.getOwned(customerId, addressId);
    await withTransaction(async (connection) => {
      await connection.execute('DELETE FROM addresses WHERE id = ?', [addressId]);
      if (address.is_default) {
        const [rows] = await connection.execute('SELECT id FROM addresses WHERE customer_id = ? ORDER BY updated_at DESC LIMIT 1', [customerId]);
        if (rows[0]) {
          await connection.execute('UPDATE addresses SET is_default = 1, updated_at = NOW() WHERE id = ?', [rows[0].id]);
        }
      }
    });
  }
}

export const addressService = new AddressService();
export default addressService;
