// Phase 2 (2026-09-03) — destination-aware warehouse ranking.
//
// The customer's delivery PIN decides which registered warehouse fulfils the
// order. Ranking, best first:
//   1. real carrier TAT to the destination, when available (fewest days wins)
//   2. otherwise PIN-code proximity — Indian PINs are hierarchical
//      (digit 1 = region, digits 1-2 = circle, digits 1-3 = sorting district),
//      so a longer shared prefix ⇒ a nearer, faster warehouse
//   3. tie-break on warehouse.priority (lower = preferred)
//
// This is a deterministic backend rule — never a frontend guess, never mock.
// The allocation service reorders its candidate list with this before choosing
// a single warehouse or splitting.

/** Length of the shared leading-digit prefix of two 6-digit PINs (0–6). */
export function sharedPinPrefix(a, b) {
  const x = String(a || '').replace(/\D/g, '');
  const y = String(b || '').replace(/\D/g, '');
  let n = 0;
  while (n < 6 && n < x.length && n < y.length && x[n] === y[n]) n += 1;
  return n;
}

/**
 * @param {Array<{id,postal_code,priority}>} warehouses  candidate ACTIVE warehouses
 * @param {string|null} destinationPostalCode
 * @param {Map<string,number>|null} tatByWarehouse  warehouseId -> transit days
 * @returns {{ ranked: Array, reason: 'TAT'|'PIN_PROXIMITY'|'PRIORITY' }}
 */
export function rankWarehousesForDestination(warehouses, destinationPostalCode, tatByWarehouse = null) {
  const list = [...(warehouses || [])];
  if (list.length <= 1) return { ranked: list, reason: 'PRIORITY' };

  const hasTat = tatByWarehouse && list.some((w) => Number.isFinite(tatByWarehouse.get(w.id)));
  if (hasTat) {
    list.sort((a, b) => {
      const ta = Number.isFinite(tatByWarehouse.get(a.id)) ? tatByWarehouse.get(a.id) : Infinity;
      const tb = Number.isFinite(tatByWarehouse.get(b.id)) ? tatByWarehouse.get(b.id) : Infinity;
      return ta - tb || (a.priority ?? 0) - (b.priority ?? 0) || String(a.id).localeCompare(String(b.id));
    });
    return { ranked: list, reason: 'TAT' };
  }

  if (destinationPostalCode && /^\d{6}$/.test(String(destinationPostalCode))) {
    list.sort((a, b) => {
      const pa = sharedPinPrefix(a.postal_code, destinationPostalCode);
      const pb = sharedPinPrefix(b.postal_code, destinationPostalCode);
      return pb - pa || (a.priority ?? 0) - (b.priority ?? 0) || String(a.id).localeCompare(String(b.id));
    });
    // If nobody shares even the region digit, this is really just priority order.
    const best = sharedPinPrefix(list[0].postal_code, destinationPostalCode);
    return { ranked: list, reason: best > 0 ? 'PIN_PROXIMITY' : 'PRIORITY' };
  }

  list.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || String(a.id).localeCompare(String(b.id)));
  return { ranked: list, reason: 'PRIORITY' };
}
