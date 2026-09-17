import { withTransaction } from '../../database/connection/transaction.js';
import { query } from '../../database/connection/pool.js';
import { AppError } from '../../utils/errors.js';
import { setProviderConfigSource, staticConfigSource } from '../../platform/shared/providerConfig.js';
import { platformRepository as R } from './repository.js';
import { PROVIDERS, providerDescriptor, secretStatus } from './capabilities.js';

// A config KEY that looks like a credential or an endpoint is rejected before
// it can be persisted (§18/§20). Secrets stay in env; adapters own endpoints.
const FORBIDDEN_KEY = /secret|token|password|passwd|api[_-]?key|private[_-]?key|credential|auth|bearer|url|uri|endpoint|host|base[_-]?url|webhook[_-]?secret/i;

function assertNonSecretConfig(config) {
  if (config == null) return {};
  if (typeof config !== 'object' || Array.isArray(config)) throw new AppError('VALIDATION_ERROR', 'config must be an object.', 400);
  for (const [k, v] of Object.entries(config)) {
    if (FORBIDDEN_KEY.test(k)) throw new AppError('PROVIDER_CONFIG_FORBIDDEN_KEY', `config key "${k}" is not allowed — secrets and endpoints are never stored here.`, 400);
    if (typeof v === 'string' && /^https?:\/\//i.test(v)) throw new AppError('PROVIDER_CONFIG_FORBIDDEN_VALUE', `config value for "${k}" looks like a URL — provider endpoints are owned by the adapter.`, 400);
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) assertNonSecretConfig(v);
  }
  return config;
}

/**
 * DB-backed non-secret config source that plugs into the existing platform
 * loader (`setProviderConfigSource`). Rows not in the DB fall back to the
 * in-code static defaults — so nothing breaks before an operator touches a
 * provider.
 */
export const dbProviderConfigSource = {
  async get(capability, providerKey) {
    const row = await R.configFor(capability, providerKey);
    if (!row) return staticConfigSource.get(capability, providerKey);
    return { capability, providerKey, enabled: Boolean(row.enabled), priority: Number(row.priority), config: row.config_json ?? {}, version: Number(row.config_version), source: 'DATABASE' };
  },
  async list(capability) {
    const rows = await R.allConfigs();
    const byKey = new Map(rows.map((r) => [`${r.capability}:${r.provider_key}`, r]));
    const out = [];
    for (const d of PROVIDERS) {
      if (capability && d.capability !== capability) continue;
      const row = byKey.get(`${d.capability}:${d.providerKey}`);
      if (row) out.push({ capability: d.capability, providerKey: d.providerKey, enabled: Boolean(row.enabled), priority: Number(row.priority), config: row.config_json ?? {}, version: Number(row.config_version), source: 'DATABASE' });
      else out.push(await staticConfigSource.get(d.capability, d.providerKey));
    }
    return out;
  },
};

export function activateDbProviderConfig() {
  setProviderConfigSource(dbProviderConfigSource);
}

export class ProviderConfigService {
  async list() {
    return dbProviderConfigSource.list();
  }

  async detail(capability, providerKey) {
    const d = providerDescriptor(capability, providerKey);
    if (!d) throw new AppError('PROVIDER_NOT_FOUND', 'Unknown provider.', 404);
    const cfg = await dbProviderConfigSource.get(capability, providerKey);
    return { ...cfg, label: d.label, webhookCapable: d.webhookCapable, secretStatus: secretStatus(capability, providerKey), revisions: await R.revisions(capability, providerKey) };
  }

  /** Update non-secret operational config. Bumps config_version + writes an immutable revision + audit (via route). */
  async update({ capability, providerKey, enabled, priority, config, staffId, note }) {
    const d = providerDescriptor(capability, providerKey);
    if (!d) throw new AppError('PROVIDER_NOT_FOUND', 'Unknown provider.', 404);
    const current = await dbProviderConfigSource.get(capability, providerKey);
    const nextEnabled = enabled === undefined ? current.enabled : Boolean(enabled);
    const nextPriority = priority === undefined ? current.priority : Number(priority);
    if (!Number.isInteger(nextPriority) || nextPriority < 0 || nextPriority > 100000) throw new AppError('VALIDATION_ERROR', 'priority must be an integer 0-100000.', 400);
    const nextConfig = config === undefined ? (current.config ?? {}) : assertNonSecretConfig(config);
    // §118 — enabling a provider whose credentials are missing is refused.
    //
    // The test is "is the caller ASSERTING enabled?", not "is it currently
    // disabled?". Some providers ship enabled in the in-code DEFAULTS while
    // their secrets are absent (`media:cloudinary` is exactly that on a fresh
    // database), and a `!current.enabled` guard waves those through — the one
    // case where an operator is told an unserviceable provider is in service.
    // Keying on `enabled !== undefined` refuses the assertion in both
    // directions while leaving a priority- or config-only edit untouched,
    // which is what the original clause was protecting.
    if (enabled !== undefined && nextEnabled && secretStatus(capability, providerKey) === 'NOT_CONFIGURED') {
      throw new AppError('PROVIDER_NOT_CONFIGURED', `Cannot enable ${d.label} — its credentials are not configured in the environment.`, 409);
    }
    const version = Number(current.version || 0) + 1;
    await withTransaction(async (tx) => {
      await R.upsertConfig(tx, { capability, providerKey, enabled: nextEnabled, priority: nextPriority, config: nextConfig, version, staffId });
      await R.insertConfigRevision(tx, { capability, providerKey, version, enabled: nextEnabled, priority: nextPriority, config: nextConfig, staffId, note });
    });

    // The Providers page is the single control plane for payment routing:
    // mirror ONLY the fields the operator actually changed onto payment_providers
    // (what PaymentOrchestrator.selectProvider() reads + the payment_attempts FK
    // references). Never touch a field the caller didn't pass — the CMS static
    // default and the payment_providers seed used to disagree for MOCK_PAYMENT
    // (migration 114 aligned the rows the CMS had never managed).
    // Best-effort — a mirror failure never fails the config write.
    if (capability === 'payments' && (enabled !== undefined || priority !== undefined)) {
      const sets = [];
      const params = [];
      if (enabled !== undefined) { sets.push('enabled = ?'); params.push(nextEnabled ? 1 : 0); }
      if (priority !== undefined) { sets.push('priority = ?'); params.push(nextPriority); }
      params.push(providerKey);
      await query(`UPDATE payment_providers SET ${sets.join(', ')} WHERE provider_code = ?`, params).catch(() => {});
    }

    return this.detail(capability, providerKey);
  }

  /** Roll back to a previous NON-SECRET config revision (§119). Records it as a new revision. */
  async rollback({ capability, providerKey, toVersion, staffId }) {
    const rev = await R.revision(capability, providerKey, toVersion);
    if (!rev) throw new AppError('PROVIDER_CONFIG_REVISION_NOT_FOUND', 'That config version was not found.', 404);
    return this.update({
      capability, providerKey, enabled: Boolean(rev.enabled), priority: Number(rev.priority),
      config: rev.config_json ?? {}, staffId, note: `rollback to v${toVersion}`,
    });
  }
}

export const providerConfigService = new ProviderConfigService();
