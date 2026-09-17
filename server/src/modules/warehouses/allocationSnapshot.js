import { createHash } from 'node:crypto';

// Pure helpers for persisting a warehouse allocation result. Kept free of any
// service/repository dependency so the checkout repository can serialize an
// allocation without pulling the allocation engine's dependency graph.

/** Stable identity of an allocation's concrete (warehouse, sku, qty) lines. */
export function allocationItemsFingerprint(allocation) {
  const lines = (allocation?.allocations || [])
    .flatMap((a) => a.items.map((i) => [a.warehouseId, i.skuId, i.quantity]))
    .sort((x, y) => x[0].localeCompare(y[0]) || x[1].localeCompare(y[1]));
  return createHash('sha256').update(JSON.stringify(lines)).digest('hex');
}

/** Immutable-friendly JSON persisted on the checkout session. */
export function serializeAllocation(allocation) {
  return {
    status: allocation.status,
    strategy: allocation.strategy,
    itemsFingerprint: allocationItemsFingerprint(allocation),
    allocations: allocation.allocations,
    unmet: allocation.unmet,
    perItem: allocation.perItem,
    allocatedAt: new Date().toISOString(),
  };
}
