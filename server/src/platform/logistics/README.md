# platform/logistics

Reserved for the shared logistics capability (Provider Platform Migration,
Phase 4). Today the logistics contract, registry, orchestrator and carrier
adapters still live under [`../../modules/shipping/`](../../modules/shipping).
When they move here they will be rebuilt on
[`../shared/`](../shared) (registry, normalized errors, config loader) —
serviceability-first orchestration, no behaviour change.
