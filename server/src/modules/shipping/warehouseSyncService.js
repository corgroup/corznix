import { AppError } from '../../utils/errors.js';
import { PROVIDER_CODES } from './providerContract.js';
import { warehouseProviderLocationRepository } from './warehouseProviderRepository.js';

// Keeps a CORCOTTON warehouse and its carrier pickup-location in step.
//
// DIRECTION IS ONE-WAY, AND THAT IS A PROVIDER LIMIT, NOT A DESIGN CHOICE.
// The Delhivery contract (implementation/phase-02/01-provider-contract-evidence.md)
// documents 18 endpoints; two touch warehouses (create, edit) and NONE reads
// one back. So:
//
//   CORCOTTON -> Delhivery   push, implemented here
//   Delhivery -> CORCOTTON   impossible over the API
//
// CORCOTTON is therefore the source of truth and the Delhivery panel must be
// treated as read-only. `detectDrift` cannot compare against the provider — it
// reports what we can actually prove locally (missing / unregistered / renamed
// mappings), which is the class of conflict that silently breaks manifesting.
//
// Two hard provider constraints shape everything below:
//   * `name` becomes `pickup_location` on every manifest and is IMMUTABLE at
//     Delhivery — there is no rename. A warehouse with a live mapping can
//     never change the field the mapping was built from.
//   * create/edit are rate limited to 10/min/IP.
export class WarehouseSyncService {
  constructor({ registry, locations = warehouseProviderLocationRepository } = {}) {
    this.registry = registry;
    this.locations = locations;
  }

  #adapter(providerCode) {
    const adapter = this.registry?.resolve(providerCode);
    if (!adapter || !adapter.implemented || !adapter.configured) {
      throw new AppError(
        'SHIPPING_PROVIDER_NOT_CONFIGURED',
        `${providerCode} is not configured in this environment, so the pickup location cannot be synced.`,
        503,
      );
    }
    return adapter;
  }

  /** Is this provider able to own its pickup locations at all? */
  supportsSync(providerCode) {
    const adapter = this.registry?.resolve(providerCode);
    return Boolean(adapter?.implemented && adapter?.configured && adapter.supports('createPickupLocation'));
  }

  /**
   * Register the warehouse AT the carrier, then persist the mapping.
   *
   * Order matters: the row is written only after the provider confirms, so
   * `warehouse_provider_locations` can never claim a pickup location that does
   * not exist at Delhivery — the exact failure that turns into a rejected
   * manifest days later.
   *
   * A transport failure is AMBIGUOUS (the warehouse may exist at Delhivery
   * even though we never read the reply) and, because there is no read
   * endpoint to check, must not be retried blindly — it surfaces as 502 with
   * `ambiguous` so an operator links the existing name instead.
   */
  async register(warehouse, { providerCode = PROVIDER_CODES.DELHIVERY, pickupMode = 'API', notes = null } = {}) {
    const adapter = this.#adapter(providerCode);
    const name = String(warehouse.providerLocationName ?? warehouse.code ?? '').trim();
    if (!name) throw new AppError('PROVIDER_LOCATION_NAME_REQUIRED', 'A pickup-location name is required.', 422);

    let result;
    try {
      result = await adapter.createPickupLocation({ ...warehouse, providerLocationName: name });
    } catch (err) {
      throw toAppError(err, 'register');
    }

    return this.locations.upsert(warehouse.id, providerCode, {
      identifier: result.providerLocationName,
      registeredAt: result.registeredAt ?? new Date(),
      pickupMode,
      status: 'ACTIVE',
      notes: notes ?? 'Registered at the carrier by CORCOTTON CMS.',
    });
  }

  /**
   * Push an address / phone change to the carrier for a warehouse that already
   * has an ACTIVE mapping. No mapping -> nothing to push (not an error: the
   * warehouse simply is not carrier-registered yet).
   *
   * The provider call fails LOUD. A silent failure here is precisely the
   * conflict this service exists to prevent: CORCOTTON showing the new address
   * while the courier keeps collecting from the old one.
   */
  async pushAddressChange(warehouseId, patch, { providerCode = PROVIDER_CODES.DELHIVERY } = {}) {
    const row = await this.locations.find(warehouseId, providerCode);
    if (!row || row.status !== 'ACTIVE') return { pushed: false, reason: 'NO_ACTIVE_MAPPING' };
    if (!ADDRESS_FIELDS.some((f) => patch[f] !== undefined)) return { pushed: false, reason: 'NO_ADDRESS_CHANGE' };

    const adapter = this.#adapter(providerCode);
    try {
      await adapter.updatePickupLocation(row.provider_location_identifier, patch);
    } catch (err) {
      throw toAppError(err, 'update');
    }
    return { pushed: true, identifier: row.provider_location_identifier };
  }

  /**
   * What we can prove locally about mapping health. Not a provider diff —
   * Delhivery exposes no read endpoint — so every finding here is derived from
   * CORCOTTON's own state.
   */
  async detectDrift(warehouses, { providerCode = PROVIDER_CODES.DELHIVERY } = {}) {
    const rows = await this.locations.listForProvider(providerCode);
    const byWarehouse = new Map(rows.map((r) => [r.warehouse_id, r]));
    const findings = [];

    for (const w of warehouses) {
      const row = byWarehouse.get(w.id);
      if (!row) {
        // Reported for every warehouse, not only active ones. A disabled
        // warehouse with no mapping is not a live problem, but staying silent
        // about it made the Warehouses list read "Registered" for a warehouse
        // that had no carrier mapping at all — a missing check is not a pass.
        findings.push({
          warehouseId: w.id, code: w.code,
          severity: w.status === 'ACTIVE' ? 'BLOCKING' : 'INFO',
          issue: 'NO_PICKUP_MAPPING',
          detail: w.status === 'ACTIVE'
            ? 'Active warehouse has no carrier pickup location — manifesting from it will fail.'
            : 'No carrier pickup location. Not blocking while the warehouse is disabled, but it must be mapped before it can ship.',
        });
        continue;
      }
      if (row.status !== 'ACTIVE') {
        findings.push({
          warehouseId: w.id, code: w.code, severity: 'WARNING', issue: 'MAPPING_INACTIVE',
          detail: `Mapping status is ${row.status}.`,
        });
      }
      if (!row.registered_at) {
        // A person having read the name in the carrier's panel is not proof the
        // carrier will accept it — but it is not the same as nobody having
        // looked, and reporting both identically is how this warning gets
        // ignored on the one warehouse that matters.
        findings.push(row.panel_verified_at
          ? {
            warehouseId: w.id, code: w.code, severity: 'INFO', issue: 'PANEL_VERIFIED_NOT_API_REGISTERED',
            detail: `Identifier was checked in the carrier panel on ${new Date(row.panel_verified_at).toISOString().slice(0, 10)}, but CORCOTTON never registered it through the API, so it cannot be confirmed programmatically.`,
          }
          : {
            warehouseId: w.id, code: w.code, severity: 'WARNING', issue: 'NEVER_REGISTERED_VIA_API',
            detail: 'Identifier was entered by hand and never confirmed by the carrier — it may not match the carrier panel.',
          });
      }
    }

    for (const row of rows) {
      if (!warehouses.some((w) => w.id === row.warehouse_id)) {
        findings.push({
          warehouseId: row.warehouse_id, code: null, severity: 'WARNING', issue: 'ORPHANED_MAPPING',
          detail: 'Mapping points at a warehouse that no longer exists.',
        });
      }
    }

    return { providerCode, checkedAt: new Date().toISOString(), findings };
  }
}

const ADDRESS_FIELDS = ['addressLine1', 'addressLine2', 'city', 'state', 'postalCode', 'country', 'contactPhone'];

// The adapter speaks a neutral error vocabulary; map it to something an
// operator can act on without leaking provider internals.
function toAppError(err, phase) {
  const code = err?.message || 'SHIPPING_PROVIDER_UNAVAILABLE';
  if (code === 'SHIPPING_PROVIDER_REQUEST_INVALID') {
    return new AppError('WAREHOUSE_SYNC_INCOMPLETE', `The warehouse is missing a field the carrier requires (${err.detail || 'unknown'}).`, 422);
  }
  if (code === 'SHIPPING_PROVIDER_RATE_LIMITED') {
    return new AppError('WAREHOUSE_SYNC_RATE_LIMITED', 'The carrier rate-limited this change (10/min). Try again shortly.', 429);
  }
  if (code === 'SHIPPING_PROVIDER_AUTH_FAILED') {
    return new AppError('WAREHOUSE_SYNC_AUTH_FAILED', 'The carrier rejected our credentials.', 502);
  }
  if (code === 'SHIPPING_PROVIDER_REJECTED') {
    return new AppError('WAREHOUSE_SYNC_REJECTED', err.providerMessage
      ? `The carrier rejected the ${phase}: ${err.providerMessage}`
      : `The carrier rejected the ${phase}.`, 422);
  }
  const e = new AppError('WAREHOUSE_SYNC_UNCONFIRMED',
    `The ${phase} request reached the carrier but the outcome is unknown. Do not retry blindly — check the carrier panel first (it exposes no read API).`, 502);
  e.ambiguous = Boolean(err?.ambiguous);
  return e;
}

// Lazily built so importing this module never eagerly constructs adapters
// (adminWarehouses imports it at module load; shipping/service.js imports the
// registry factory, and a top-level call would be a cycle).
let _singleton = null;
export async function getWarehouseSyncService() {
  if (!_singleton) {
    const { createDefaultShippingRegistry } = await import('./service.js');
    _singleton = new WarehouseSyncService({ registry: createDefaultShippingRegistry() });
  }
  return _singleton;
}
