import { z } from 'zod';
import addressService from './service.js';

function toDto(row) {
  return {
    id: row.id,
    type: row.type,
    firstName: row.first_name,
    lastName: row.last_name,
    phone: row.phone,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    district: row.district ?? null,
    state: row.state,
    postalCode: row.postal_code,
    country: row.country,
    isDefault: Boolean(row.is_default),
  };
}

const addressSchema = z.object({
  type: z.enum(['SHIPPING', 'BILLING']).optional(),
  firstName: z.string().trim().min(1).max(120),
  lastName: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(1),
  addressLine1: z.string().trim().min(1).max(255),
  addressLine2: z.string().trim().max(255).optional(),
  city: z.string().trim().min(1).max(120),
  district: z.string().trim().max(120).optional(),
  state: z.string().trim().min(1).max(120),
  // First digit 1-9: there is no postal zone 0, so a leading zero is
  // certainly wrong rather than merely unverified.
  postalCode: z.string().trim().regex(/^[1-9]\d{5}$/, 'Enter a valid 6-digit PIN code.'),
  isDefault: z.boolean().optional(),
});

export async function list(req, res, next) {
  try {
    const rows = await addressService.list(req.customer.id);
    res.json({ data: rows.map(toDto) });
  } catch (err) {
    next(err);
  }
}

export async function create(req, res, next) {
  try {
    const payload = addressSchema.parse(req.body);
    const row = await addressService.create(req.customer.id, payload);
    res.status(201).json({ data: toDto(row) });
  } catch (err) {
    next(err);
  }
}

export async function update(req, res, next) {
  try {
    const payload = addressSchema.parse(req.body);
    const row = await addressService.update(req.customer.id, req.params.id, payload);
    res.json({ data: toDto(row) });
  } catch (err) {
    next(err);
  }
}

export async function setDefault(req, res, next) {
  try {
    const row = await addressService.setDefault(req.customer.id, req.params.id);
    res.json({ data: toDto(row) });
  } catch (err) {
    next(err);
  }
}

export async function remove(req, res, next) {
  try {
    await addressService.delete(req.customer.id, req.params.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
