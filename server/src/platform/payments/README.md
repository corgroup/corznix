# platform/payments

Reserved for the shared payments capability (Provider Platform Migration,
Phase 7). Today the payment contract, registry, orchestrator and provider
adapters (Cashfree, mock) live under
[`../../modules/payments/`](../../modules/payments). The webhook →
verify → normalize → domain path there already matches blueprint §27; this
move is a re-home onto [`../shared/`](../shared), not a redesign.
