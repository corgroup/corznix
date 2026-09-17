# platform/auth-providers

Reserved for the authentication provider-isolation boundary (Provider
Platform Migration, Phase 6). **The current working customer login flow does
not change** — this is an internal boundary only.

Today the isolation already exists inside
[`../../modules/auth/`](../../modules/auth):

- `googleVerifier.js` — Google identity adapter (`verify` → normalized claims,
  never creates customers)
- `otpProviders.js` — OTP **delivery** adapters (Infyntra WhatsApp, SMTP)
  behind `otpDeliveryService.send(...)`; `AuthService` owns OTP
  length/expiry/resend/verification, not the adapter

Phase 6 wires these to [`../shared/`](../shared) (registry entries under
capabilities `auth-identity` and `auth-otp-delivery`, normalized errors) and
folds in the second, currently-unabstracted OTP delivery call site in
`modules/customers/controller.js` (the `VERIFY_CONTACT` flow). Core
`AuthService` / OTP logic / session / customer resolution stay where they are.
