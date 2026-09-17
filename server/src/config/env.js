import 'dotenv/config';
import crypto from 'node:crypto';
import { z } from 'zod';

const booleanFromEnv = (value) => (value === undefined || value === '' ? undefined : String(value).trim().toLowerCase() === 'true');
const undefinedIfEmpty = (value) => (value === undefined || String(value).trim() === '' ? undefined : value);

// SECURITY FIX (Wave 5 security review — see docs/MIGRATION.md §18): this
// schema previously had `JWT_SECRET: z.string().default('change-me-to-a-
// long-random-string-at-least-32-chars')` — a well-known, guessable
// fallback secret that would silently let the server boot (and forge
// valid tokens) if the real env var was ever missing. Removed. `JWT_SECRET`
// and `OTP_PEPPER` are now *required* in the schema (no default) — a
// production boot with either missing fails loudly via `parsed.success`
// below, exactly like every other misconfiguration this file already
// guards against. For local development only (never production — enforced
// by the `NODE_ENV` check, not a flag that could be misconfigured), a
// missing value is generated fresh at boot with a loud console warning, so
// a new contributor's first `npm run dev` doesn't require manually
// generating secrets before OTP/session work is testable at all.
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_NAME: z.string().default('cor_group'),
  DB_USER: z.string().default('root'),
  DB_PASSWORD: z.string().default(''),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars long').optional(),
  JWT_ISSUER: z.string().default('cor-group-backend'),
  JWT_AUDIENCE: z.string().default('cor-group-client'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),

  // Session (opaque, rotating refresh token — see modules/auth/service.js's
  // issueSession/refreshSession). Cookie-based, httpOnly.
  SESSION_COOKIE_NAME: z.string().default('cor_group_session'),
  REFRESH_COOKIE_NAME: z.string().default('cor_group_refresh'),
  // Customer session policy (modules/auth/sessionPolicy.js). A session ends at
  // whichever comes first, enforced server-side on every authenticated request
  // and on refresh:
  //  - IDLE: this many minutes with no authenticated activity;
  //  - MAX LIFETIME: this many hours after login — refreshing never extends it.
  // It replaces SESSION_TTL_DAYS (30), which every refresh pushed forward
  // again, so a customer who came back within a month was never signed out.
  CUSTOMER_SESSION_IDLE_TIMEOUT_MINUTES: z.coerce.number().int().positive().max(10080).default(720),
  CUSTOMER_SESSION_MAX_LIFETIME_HOURS: z.coerce.number().int().positive().max(720).default(168),

  // OTP policy (migration brief §10-14) — 4-digit, HMAC-SHA256(pepper),
  // short-lived, single-use, attempt-limited. See utils/crypto.js.
  OTP_PEPPER: z.string().min(16, 'OTP_PEPPER must be at least 16 chars long').optional(),
  OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().nonnegative().default(60),
  // MOCK: OTP is generated/verified for real but never actually sent over
  // WhatsApp/SMTP — logged to the server console instead (DEV/TEST only,
  // see providers/otpProviders.js's MockOtpProvider — it refuses to run
  // when NODE_ENV=production regardless of this setting).
  OTP_PROVIDER_MODE: z.enum(['MOCK', 'REAL']).default('MOCK'),

  // Wave 8A — staff/admin (CMS) authentication. Server-authoritative,
  // DB-backed opaque sessions delivered as an HttpOnly cookie whose name
  // never collides with the customer SESSION_COOKIE_NAME above.
  STAFF_SESSION_COOKIE_NAME: z.string().default('cor_group_staff_session'),
  STAFF_SESSION_TTL_HOURS: z.coerce.number().int().positive().max(168).default(12),
  STAFF_SESSION_IDLE_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(120),
  STAFF_PASSWORD_MIN_LENGTH: z.coerce.number().int().min(12).max(200).default(12),
  STAFF_LOGIN_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(300000),
  STAFF_LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  // Origins allowed to call /api/v1/admin/* with credentials. Defaults to
  // the local CMS dev origin only — never wildcarded.
  CMS_ALLOWED_ORIGINS: z.string().optional(),

  GOOGLE_CLIENT_ID: z.string().optional(),
  // AES-256 key (64 hex chars or base64) encrypting customer COD-refund bank
  // account numbers. Unset ⇒ bank payouts are refused, never stored in the
  // clear; UPI refunds are unaffected. See utils/payoutCrypto.js.
  PAYOUT_ENCRYPTION_KEY: z.string().optional(),
  // AES-256 key (64 hex chars or base64) encrypting provider credentials the
  // server keeps and renews itself — the Instagram access token. Unset ⇒ an
  // Instagram account cannot be connected. See utils/providerSecretCrypto.js.
  PROVIDER_SECRET_ENCRYPTION_KEY: z.string().optional(),
  // Instagram: renew the token when due and pull the latest posts.
  INSTAGRAM_WORKER_ENABLED: z.preprocess(booleanFromEnv, z.boolean().default(true)),
  INSTAGRAM_SYNC_INTERVAL_MS: z.coerce.number().int().min(60000).default(1800000),
  // Provider health: re-derived on a timer, so a failing provider reaches the
  // CMS bell without anyone opening Platform → Providers.
  PROVIDER_HEALTH_WORKER_ENABLED: z.preprocess(booleanFromEnv, z.boolean().default(true)),
  PROVIDER_HEALTH_INTERVAL_MS: z.coerce.number().int().min(60000).default(300000),

  INFYNTRA_API_BASE_URL: z.string().optional(),
  INFYNTRA_API_KEY: z.string().optional(),
  INFYNTRA_PHONE_ID: z.string().optional(),
  INFYNTRA_OTP_TEMPLATE: z.string().optional(),
  INFYNTRA_OTP_TEMPLATE_LANGUAGE: z.string().optional(),
  PROVIDER_PHONE_FORMAT: z.enum(['10_DIGITS_NO_COUNTRY_CODE', '91_PLUS_10_DIGITS']).default('10_DIGITS_NO_COUNTRY_CODE'),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_SECURE: z.preprocess(booleanFromEnv, z.boolean().optional()),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  EMAIL_FROM: z.string().optional(),

  // Phase 2 — per-purpose SMTP accounts. A *_OTP / *_ORDER / *_SUPPORT var
  // overrides the plain SMTP_* for that channel. `smtpAccount(purpose)` in
  // config/index.js resolves the effective config with the fallback chain.
  SMTP_HOST_OTP: z.string().optional(),
  SMTP_USER_OTP: z.string().optional(),
  SMTP_PASSWORD_OTP: z.string().optional(),
  SMTP_FROM_OTP: z.string().optional(),
  SMTP_HOST_ORDER: z.string().optional(),
  SMTP_USER_ORDER: z.string().optional(),
  SMTP_PASSWORD_ORDER: z.string().optional(),
  SMTP_FROM_ORDER: z.string().optional(),
  SMTP_HOST_SUPPORT: z.string().optional(),
  SMTP_USER_SUPPORT: z.string().optional(),
  SMTP_PASSWORD_SUPPORT: z.string().optional(),
  SMTP_FROM_SUPPORT: z.string().optional(),
  // Marketing campaigns (abandoned cart, new collection, newsletter) send from
  // their own mailbox so a customer blocking promotions never costs them an
  // order confirmation. Falls back to the plain SMTP_* account, like the rest.
  SMTP_HOST_MARKETING: z.string().optional(),
  SMTP_USER_MARKETING: z.string().optional(),
  SMTP_PASSWORD_MARKETING: z.string().optional(),
  SMTP_FROM_MARKETING: z.string().optional(),

  // Owner Delivery — the ops mailbox notified when a customer places an
  // Owner-Delivery order (the store delivers it themselves).
  OWNER_DELIVERY_NOTIFY_EMAIL: z.string().optional(),

  // WP-06 — the communications ENGINE's own provider mode, independent of
  // OTP_PROVIDER_MODE (auth OTP is a separate system, §124 of the Wave 8G-7
  // migration notes, and stays that way). Split Email/WhatsApp on purpose:
  // real transactional Email only needs an SMTP relay, real WhatsApp needs a
  // provider-approved message template — the two roll out on independent
  // timelines. Reuses the same SMTP_*/INFYNTRA_* credentials as auth OTP
  // (shared account config) through a separate adapter (communications/
  // providers.js never imports modules/auth/).
  COMMUNICATIONS_EMAIL_PROVIDER_MODE: z.enum(['MOCK', 'REAL']).default('MOCK'),
  COMMUNICATIONS_WHATSAPP_PROVIDER_MODE: z.enum(['MOCK', 'REAL']).default('MOCK'),

  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),

  // Media Abstraction provider registry (server/src/platform/media) — see
  // docs/MEDIA_ABSTRACTION.md. Business/domain code never reads this
  // directly; only platform/media/index.js resolves it into a provider
  // instance.
  MEDIA_PROVIDER: z.enum(['cloudinary']).default('cloudinary'),

  CORS_ALLOWED_ORIGINS: z.string().optional(),

  // Express `trust proxy` value. Behind nginx on the VPS set this to the
  // trusted-hop count (1) or the docker bridge subnet; leave unset for
  // direct local dev. Must never be "true" (spoofable — defeats IP rate
  // limiting).
  TRUST_PROXY: z
    .string()
    .optional()
    .refine((value) => value === undefined || value === '' || value.toLowerCase() !== 'true', {
      message: 'TRUST_PROXY must not be "true" — use a hop count (e.g. 1), a preset, or a CIDR list.',
    }),

  INVENTORY_RESERVATION_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  // How long a checkout hold can be kept alive while its customer is still on
  // the page, measured from when the hold was taken. The keep-alive stops here.
  CHECKOUT_HOLD_MAX_SECONDS: z.coerce.number().int().positive().default(3600),
  INVENTORY_RESERVATION_EXPIRY_WORKER_ENABLED: z.preprocess(booleanFromEnv, z.boolean().default(true)),
  INVENTORY_RESERVATION_EXPIRY_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
  INVENTORY_RESERVATION_EXPIRY_BATCH_SIZE: z.coerce.number().int().positive().max(500).default(100),
  // MOCK = mocked booking (no carrier call). REAL = book with the real carrier
  // (Delhivery). Tolerant of common misconfigurations: a provider name
  // ("DELHIVERY"), "PRODUCTION" / "LIVE" ⇒ REAL; blank / "TEST" ⇒ MOCK;
  // anything else ⇒ refuse to boot (never a silent MOCK or a deceptive "real").
  SHIPPING_PROVIDER_MODE: z.preprocess((v) => {
    const s = String(v ?? '').trim().toUpperCase();
    if (s === 'MOCK' || s === 'REAL') return s;
    if (['DELHIVERY', 'PRODUCTION', 'PROD', 'LIVE', 'ENABLED'].includes(s)) return 'REAL';
    if (s === '' || s === 'TEST' || s === 'SANDBOX' || s === 'DISABLED' || s === 'OFF') return 'MOCK';
    // An unrecognised value is a misconfiguration, not a mode. Silently
    // running MOCK would let a typo ship fake AWBs from a "real" deploy, so
    // refuse to boot instead.
    throw new Error(`[env] SHIPPING_PROVIDER_MODE="${v}" is not MOCK or REAL.`);
  }, z.enum(['MOCK', 'REAL'])).default('MOCK'),
  SHIPPING_STANDARD_CHARGE_MINOR: z.coerce.number().int().nonnegative().default(0),
  SHIPPING_PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  SHIPPING_ORIGIN_POSTAL_CODE: z.preprocess(undefinedIfEmpty, z.string().regex(/^\d{6}$/).optional()),

  // Phase 2 · Slice 4 — PDP "check delivery" range. The provider gives ONE EDD;
  // `latest = earliest + BUFFER_DAYS` is a business pad (packing + variance).
  // DISPATCH_LAG_DAYS = order-placed -> courier-handover (TAT counts from there).
  PDP_DELIVERY_RANGE_BUFFER_DAYS: z.coerce.number().int().min(0).max(10).default(2),
  PDP_DISPATCH_LAG_DAYS: z.coerce.number().int().min(0).max(7).default(1),
  // Phase 2 · Slice 7 — at place-order (REAL mode) re-check the frozen shipping
  // quote against a fresh provider rate; a customer-charge delta over this many
  // paise forces a re-select (Surface is always ₹0 so only Express can move).
  SHIPPING_REVALIDATION_TOLERANCE_MINOR: z.coerce.number().int().min(0).default(100),
  DELHIVERY_API_BASE_URL: z.preprocess(undefinedIfEmpty, z.string().url().optional()),
  // Phase 2 — environment-specific Delhivery base URLs. If DELHIVERY_API_BASE_URL
  // is not set explicitly, it is resolved (post-parse) from these + DELHIVERY_ENVIRONMENT.
  DELHIVERY_API_STAGING_URL: z.preprocess(undefinedIfEmpty, z.string().url().optional()),
  DELHIVERY_API_PRODUCTION_URL: z.preprocess(undefinedIfEmpty, z.string().url().optional()),
  DELHIVERY_ENVIRONMENT: z.enum(['staging', 'production']).optional(),
  // CORCOTTON's credential for calling Delhivery (Authorization: Token …,
  // read by delhiveryAdapter.js). BUG FIX 2026-09-05: this field was never
  // declared here, so Zod silently stripped it from every parsed `env` —
  // the REAL-mode boot guard below always failed even with a real token in
  // .env, and had it not, every live Delhivery call would have sent
  // "Authorization: Token undefined". `DELHIVERY_API_PRODUCTION_TOKEN`
  // below is a separate, distinct field — do not confuse the two.
  DELHIVERY_API_TOKEN: z.preprocess(undefinedIfEmpty, z.string().optional()),
  DELHIVERY_API_PRODUCTION_TOKEN: z.string().optional(),
  // WP-01 — inbound Scan Push authenticity. Distinct from DELHIVERY_API_TOKEN
  // (that one is CORCOTTON's credential for calling Delhivery; this one is the
  // shared secret Delhivery is configured to send back to CORCOTTON in every
  // webhook call). The supplied Delhivery templates do not standardize a
  // signature scheme — "client supplies an authorization header key/value
  // pair" — so this is a constant-time shared-secret header comparison, not
  // an HMAC. Unset => the logistics/DELHIVERY webhook verifier always
  // rejects (fail-closed); the logistics/MOCK path (dev/staging replay,
  // verify-logistics-webhooks.js) is intentionally left unverified.
  DELHIVERY_WEBHOOK_TOKEN: z.string().optional(),
  DELHIVERY_WEBHOOK_TOKEN_HEADER: z.string().default('x-delhivery-webhook-token'),
  // Phase 2 §24 — staging-safe onboarding. OBSERVE: verify + store + parse +
  // record a diagnostic, but DO NOT mutate shipment/order state. APPLY: normal
  // production behaviour. Default APPLY so existing behaviour is unchanged.
  LOGISTICS_WEBHOOK_APPLY: z.enum(['OBSERVE', 'APPLY']).default('APPLY'),
  CASHFREE_ENVIRONMENT: z.enum(['SANDBOX','PRODUCTION']).default('SANDBOX'),
  CASHFREE_API_BASE_URL: z.preprocess(undefinedIfEmpty, z.string().url().optional()),
  CASHFREE_API_VERSION: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default('2025-01-01'),
  CASHFREE_CLIENT_ID: z.preprocess(undefinedIfEmpty, z.string().optional()),
  CASHFREE_CLIENT_SECRET: z.preprocess(undefinedIfEmpty, z.string().optional()),

  // Razorpay — second payment provider. Enabled from the CMS Providers page;
  // refused unless RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET are present.
  RAZORPAY_API_BASE_URL: z.preprocess(undefinedIfEmpty, z.string().url().optional()),
  RAZORPAY_ENVIRONMENT: z.enum(['SANDBOX', 'PRODUCTION']).default('SANDBOX'),
  RAZORPAY_KEY_ID: z.preprocess(undefinedIfEmpty, z.string().optional()),
  RAZORPAY_KEY_SECRET: z.preprocess(undefinedIfEmpty, z.string().optional()),
  RAZORPAY_WEBHOOK_SECRET: z.preprocess(undefinedIfEmpty, z.string().optional()),

  PAYMENT_RETURN_BASE_URL: z.string().url().default('http://localhost:5173'),
  PAYMENT_RESERVATION_TTL_SECONDS: z.coerce.number().int().positive().default(1800),
  ORDER_FINALIZATION_WORKER_ENABLED: z.preprocess(booleanFromEnv, z.boolean().default(true)),
  ORDER_FINALIZATION_INTERVAL_MS: z.coerce.number().int().positive().default(15000),
  ORDER_FINALIZATION_BATCH_SIZE: z.coerce.number().int().positive().max(100).default(20),

  // Automated shipment workflow (package -> book -> AWB -> label -> pickup).
  // Business rule (2026-09-04): automation stops at warehouse allocation, so
  // this defaults OFF / MANUAL. The CMS per-step + explicit "Run automation"
  // operator actions still work; the system never auto-drives them.
  SHIPMENT_AUTOMATION_ENABLED: z.preprocess(booleanFromEnv, z.boolean().default(false)),
  SHIPMENT_AUTOMATION_MODE: z.enum(['AUTO', 'MANUAL']).default('MANUAL'),
  SHIPMENT_AUTOMATION_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
  SHIPMENT_AUTOMATION_BATCH_SIZE: z.coerce.number().int().positive().max(100).default(10),

  // Phase 2 · Slice 13 — track PULL reconciliation. Backstop for missed Scan
  // Push webhooks: periodically GET /api/v1/packages/json/ for in-flight booked
  // shipments and reconcile through the same applier the webhook uses. Also
  // resolves BOOKING_UNKNOWN shipments against the carrier.
  SHIPMENT_TRACK_PULL_ENABLED: z.preprocess(booleanFromEnv, z.boolean().default(true)),
  SHIPMENT_TRACK_PULL_INTERVAL_MS: z.coerce.number().int().positive().default(1_800_000), // 30 min
  SHIPMENT_TRACK_PULL_BATCH_SIZE: z.coerce.number().int().positive().max(50).default(40), // doc: <= 50 waybills/call
  SHIPMENT_TRACK_PULL_STALE_MINUTES: z.coerce.number().int().positive().default(180),

  // Phase 2 · Slice 17 — carrier documents (EPOD / QC / Sorter push + Download
  // Document API). Cap on base64 image bytes copied from a push into private
  // document storage; a larger payload is recorded as PENDING_FETCH instead.
  SHIPMENT_DOCUMENT_MAX_BYTES: z.coerce.number().int().positive().default(10_485_760), // 10 MiB

  // Phase 2 · Slice 18 — NDR (failed delivery attempt) actions. The submit is
  // async (returns a UPL id); this worker polls get_bulk_upl for the result.
  // RE_ATTEMPT is capped per shipment (Dev_API.docx: "attempt 1-2").
  NDR_POLL_ENABLED: z.preprocess(booleanFromEnv, z.boolean().default(true)),
  NDR_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(900_000), // 15 min
  NDR_MAX_REATTEMPTS: z.coerce.number().int().positive().max(5).default(2),

  // Wave 7A.1 — durable automatic recovery for Orders that committed but whose
  // post-commit initial-Fulfillment bootstrap did not. A safety net only:
  // correctness comes from ensureForOrder being DB-idempotent, so a slower
  // cadence than order finalization is deliberate.
  FULFILLMENT_RECOVERY_WORKER_ENABLED: z.preprocess(booleanFromEnv, z.boolean().default(true)),
  FULFILLMENT_RECOVERY_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
  FULFILLMENT_RECOVERY_BATCH_SIZE: z.coerce.number().int().positive().max(500).default(50),

  // Wave 8C-5 — private document artifact storage. LOCAL driver keeps rendered
  // PDFs under a server-owned directory (never a served/static path); no
  // secrets. A future R2/S3 driver plugs into DocumentStorageProvider.
  DOCUMENT_STORAGE_DRIVER: z.enum(['LOCAL']).default('LOCAL'),
  DOCUMENT_STORAGE_LOCAL_PATH: z.string().default('./.private-storage/documents'),

  // Customer-facing storefront origin — used to build links in customer
  // notifications (e.g. the "return to your cart" link in an abandoned-cart
  // reminder). No trailing slash.
  STOREFRONT_BASE_URL: z.string().url().default('http://localhost:5173'),
  // Department of Posts PIN directory on the Government Open Data platform
  // (data.gov.in). Optional: with no key, PIN lookups report UNAVAILABLE and
  // the address form stays fully manual. An empty value counts as unset, so a
  // blank line in an env file cannot fail the boot.
  DATA_GOV_IN_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().min(1).optional()),
  POSTAL_DIRECTORY_RESOURCE_ID: z.string().trim().min(1).default('5c2f62fe-5afa-4119-a499-fec9d604d5bd'),
  POSTAL_LOOKUP_TIMEOUT_MS: z.coerce.number().int().positive().max(15000).default(4000),

  // Abandoned-cart recovery worker. Per-campaign enable/disable lives in the
  // CMS (the campaign's status in Messaging → Campaigns); this only turns the scanner on/off
  // for the whole process. A tick with no ACTIVE campaign is a cheap no-op.
  ABANDONED_CART_WORKER_ENABLED: z.preprocess(booleanFromEnv, z.boolean().default(true)),
  ABANDONED_CART_INTERVAL_MS: z.coerce.number().int().positive().default(900_000), // 15 min
  ABANDONED_CART_BATCH_SIZE: z.coerce.number().int().positive().max(200).default(50),
  // Marketing campaigns (Offer / New Collection). The worker drains launched
  // campaigns and starts scheduled ones; without it a launched campaign sat in
  // SENDING until someone pressed "Process queue now" (production 2026-09-17).
  // Batch sizes were read by the service but never declared here, so the zod
  // parse dropped them and they could not be configured at all.
  // The API's public origin (e.g. https://api.corcotton.in). Enables RFC 8058
  // one-click List-Unsubscribe on marketing email.
  PUBLIC_API_BASE_URL: z.preprocess(undefinedIfEmpty, z.string().url().optional()),
  // A person is not sent another marketing campaign on a channel within this
  // many hours of their last marketing message there. Meta silently drops
  // marketing messages to people who receive too many (error 131049), and a
  // customer messaged twice in an hour is a customer who opts out. 0 = off.
  MARKETING_FREQUENCY_CAP_HOURS: z.coerce.number().int().min(0).max(720).default(24),
  MARKETING_CAMPAIGN_WORKER_ENABLED: z.preprocess(booleanFromEnv, z.boolean().default(true)),
  MARKETING_CAMPAIGN_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  MARKETING_BATCH_SIZE: z.coerce.number().int().positive().default(100),
  // Ceiling a campaign's own batch size is clamped to — the provider's real
  // per-pass limit, not an application limit on audience size.
  MARKETING_MAX_BATCH_SIZE: z.coerce.number().int().positive().max(5000).default(500),
  MARKETING_SEND_SPACING_MS: z.coerce.number().int().min(0).max(10_000).default(0),

  // Careers — the ops mailbox emailed on every job application. Defaults to
  // careers@corcotton.in when unset (mirrors OWNER_DELIVERY_NOTIFY_EMAIL).
  CAREERS_NOTIFY_EMAIL: z.string().optional(),

  // Multi-company CMS (implementation/multi-company/DESIGN.md) — Phase 6
  // cut-over. resolveBrandContext middleware resolves req.brandId/
  // req.brandScope on every /api/v1/admin/* request either way; BLOCKING
  // (the default from Phase 6 on) actually refuses a violation (no
  // accessible brands, or a candidate brand with no access grant) with a
  // 403 before any handler runs. ADVISORY (Phases 2-5's behaviour — only
  // logs via securityEvent and lets the request through) stays available
  // as the rollback path per DESIGN.md §8: a single env var flip, no code
  // change.
  BRAND_CONTEXT_ENFORCEMENT: z.enum(['ADVISORY', 'BLOCKING']).default('BLOCKING'),

  // Whether `GET /me` asks a staff member with 2+ accessible companies to
  // explicitly pick one before entering the shell (the CompanySelection
  // screen). Defaults OFF: as of Phase 3, Cor-Znix has zero real content —
  // only SUPER_ADMIN (implicit access to every brand) would ever see the
  // prompt today, and forcing a choice between "the real company" and "the
  // empty one" on every login is just friction. `currentBrandForSession`
  // still resolves a sensible default (the `is_default` brand) either way,
  // and the sidebar switcher (Phase 2) works regardless of this flag — this
  // only gates the forced first-login prompt. Flip to true once Cor-Znix
  // work actually starts (DESIGN.md Phase 7).
  COMPANY_SELECTION_REQUIRED: z.preprocess(booleanFromEnv, z.boolean().default(false)),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('[env] Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

// ---------------------------------------------------------------------------
// Phase 2 — configuration mapping / resolution.
// ---------------------------------------------------------------------------

// 1. SMTP: fall the plain SMTP_* vars back to the per-purpose OTP account so
//    existing readers (auth OTP, communications) keep working when only the
//    *_OTP / *_ORDER / *_SUPPORT vars are set.
env.SMTP_HOST = env.SMTP_HOST || env.SMTP_HOST_OTP || env.SMTP_HOST_ORDER || env.SMTP_HOST_SUPPORT;
env.SMTP_USER = env.SMTP_USER || env.SMTP_USER_OTP || env.SMTP_USER_ORDER || env.SMTP_USER_SUPPORT;
env.SMTP_PASSWORD = env.SMTP_PASSWORD || env.SMTP_PASSWORD_OTP || env.SMTP_PASSWORD_ORDER || env.SMTP_PASSWORD_SUPPORT;
env.SMTP_FROM = env.SMTP_FROM || env.SMTP_FROM_OTP || env.EMAIL_FROM;

// Normalise the storefront origin — templates append paths to it.
if (env.STOREFRONT_BASE_URL) env.STOREFRONT_BASE_URL = env.STOREFRONT_BASE_URL.replace(/\/+$/, '');

// 2. Delhivery base URL: explicit DELHIVERY_API_BASE_URL wins; otherwise pick
//    the staging / production URL by DELHIVERY_ENVIRONMENT (default staging).
if (!env.DELHIVERY_API_BASE_URL) {
  env.DELHIVERY_API_BASE_URL = env.DELHIVERY_ENVIRONMENT === 'production'
    ? (env.DELHIVERY_API_PRODUCTION_URL || env.DELHIVERY_API_STAGING_URL)
    : (env.DELHIVERY_API_STAGING_URL || env.DELHIVERY_API_PRODUCTION_URL);
}
if (env.DELHIVERY_API_BASE_URL) env.DELHIVERY_API_BASE_URL = env.DELHIVERY_API_BASE_URL.replace(/\/+$/, '');
if (env.SHIPPING_PROVIDER_MODE === 'REAL' && env.DELHIVERY_API_BASE_URL) {
  console.warn(`[env] Delhivery: mode=REAL base=${env.DELHIVERY_API_BASE_URL} (DELHIVERY_ENVIRONMENT=${env.DELHIVERY_ENVIRONMENT || 'staging(default)'}). The token must belong to THIS environment.`);
}

// 3. Communications engine (order/support emails, WhatsApp notifications) stays
//    on its explicit COMMUNICATIONS_*_PROVIDER_MODE flag (default MOCK). Auth
//    OTP is separate and already governed by OTP_PROVIDER_MODE.

export function isProduction() {
  return env.NODE_ENV === 'production';
}

// Generates a random 64-hex-char (32-byte) value — used only for the two
// dev-time secret fallbacks below. Never logged in full; a truncated
// preview is printed so a developer can tell secrets differ across
// restarts without the real value ever appearing in terminal/CI output.
function devOnlyRandomSecret(label) {
  const value = crypto.randomBytes(32).toString('hex');
  console.warn(
    `[env] ${label} is not set — generating a random development-only value (${value.slice(0, 8)}…). ` +
      `Sessions/OTP challenges created this run will not survive a restart. Set ${label} in server/.env before deploying.`
  );
  return value;
}

if (!env.JWT_SECRET) {
  if (isProduction()) {
    console.error('[env] JWT_SECRET is required in production and was not set. Refusing to start with an insecure default.');
    process.exit(1);
  }
  env.JWT_SECRET = devOnlyRandomSecret('JWT_SECRET');
}

if (!env.OTP_PEPPER) {
  if (isProduction()) {
    console.error('[env] OTP_PEPPER is required in production and was not set. Refusing to start with an insecure default.');
    process.exit(1);
  }
  env.OTP_PEPPER = devOnlyRandomSecret('OTP_PEPPER');
}

// SHIPPING_PROVIDER_MODE=REAL selects the real carrier adapter (Delhivery)
// via the Provider Registry. It must not boot into a deceptively "real"
// mode that cannot actually call the provider — and it must never silently
// fall back to MOCK (the Mock adapter is already inert in production).
if (env.SHIPPING_PROVIDER_MODE === 'REAL' && !(env.DELHIVERY_API_BASE_URL && env.DELHIVERY_API_TOKEN)) {
  console.error(
    '[env] SHIPPING_PROVIDER_MODE=REAL requires DELHIVERY_API_BASE_URL and DELHIVERY_API_TOKEN. '
      + 'Set both, or use SHIPPING_PROVIDER_MODE=MOCK.'
  );
  process.exit(1);
}

// WP-06 — same "never boot into a deceptively real mode" rule as shipping.
if (env.COMMUNICATIONS_EMAIL_PROVIDER_MODE === 'REAL' && !(env.SMTP_HOST && (env.SMTP_FROM || env.EMAIL_FROM))) {
  console.error(
    '[env] COMMUNICATIONS_EMAIL_PROVIDER_MODE=REAL requires SMTP_HOST and SMTP_FROM (or EMAIL_FROM). '
      + 'Set both, or use COMMUNICATIONS_EMAIL_PROVIDER_MODE=MOCK.'
  );
  process.exit(1);
}
if (env.COMMUNICATIONS_WHATSAPP_PROVIDER_MODE === 'REAL' && !(env.INFYNTRA_API_BASE_URL && env.INFYNTRA_API_KEY && env.INFYNTRA_PHONE_ID)) {
  console.error(
    '[env] COMMUNICATIONS_WHATSAPP_PROVIDER_MODE=REAL requires INFYNTRA_API_BASE_URL, INFYNTRA_API_KEY and INFYNTRA_PHONE_ID. '
      + 'Set all three, or use COMMUNICATIONS_WHATSAPP_PROVIDER_MODE=MOCK.'
  );
  process.exit(1);
}

export function isMockOtpProviderEnabled() {
  return env.OTP_PROVIDER_MODE === 'MOCK';
}
