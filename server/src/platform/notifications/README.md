# platform/notifications

Reserved for the notification capability (Provider Platform Migration,
Phase 5). **Greenfield** — the platform has no `NotificationService`,
channels, resolvers, templates, or outbox today; the only transactional
messaging that exists is auth OTP delivery (see
[`../auth-providers/`](../auth-providers)).

Planned shape (blueprint §11/§12/§29):
`NotificationService → channel (email | whatsapp) → resolver → adapter`,
with a provider-neutral `adapter.send(message)` (no event-specific methods),
fixed sender identities, and a MySQL transactional outbox + worker.
