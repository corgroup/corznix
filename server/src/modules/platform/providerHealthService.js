import { platformRepository as R } from './repository.js';
import { PROVIDERS, secretStatus } from './capabilities.js';
import { dbProviderConfigSource } from './providerConfigService.js';
import { staffNotificationService } from '../staffNotifications/service.js';

const WINDOW_MS = 24 * 60 * 60 * 1000;
const AUTH_CODES = new Set(['PROVIDER_AUTH_FAILED', 'PROVIDER_MISCONFIGURED']);

// Health changes staff must act on reach the CMS bell as a SYSTEM notification
// (which plays the service sound): an enabled provider going bad, and the
// same provider working again. Severity per bad status.
const ALERT = { UNAVAILABLE: 'CRITICAL', MISCONFIGURED: 'CRITICAL', DEGRADED: 'WARNING' };
const HEADLINE = {
  UNAVAILABLE: 'is unavailable',
  MISCONFIGURED: 'credentials look invalid',
  DEGRADED: 'is failing often',
  HEALTHY: 'is working again',
};

async function alertStaff({ capability, providerKey, from, to, reason, enabled }) {
  // A first reading (no previous status) is not a change, and a disabled
  // provider takes no new work.
  if (!from || !enabled) return;
  const wentBad = Boolean(ALERT[to]);
  const recovered = to === 'HEALTHY' && Boolean(ALERT[from]);
  if (!wentBad && !recovered) return;
  const label = PROVIDERS.find((d) => d.capability === capability && d.providerKey === providerKey)?.label || providerKey;
  await staffNotificationService.record({
    category: 'SYSTEM',
    eventKey: `PROVIDER_${to}`,
    severity: wentBad ? ALERT[to] : 'INFO',
    title: `${label} ${HEADLINE[to]}`,
    body: reason,
    link: '/platform/providers',
    entityType: 'provider',
    entityId: `${capability}:${providerKey}`,
    // Ten-minute bucket: two API processes seeing the same change post one row.
    dedupeKey: `provider_health:${capability}:${providerKey}:${from}>${to}:${Math.floor(Date.now() / 600_000)}`,
  });
}

// Health is DERIVED from operational evidence (§30) — config validity + real
// provider-attempt outcomes in a recent window. It never triggers a
// side-effecting or expensive call (§31), and it NEVER mutates business data
// (§34 — HEALTH_AUTO_BUSINESS_MUTATION = 0).
export class ProviderHealthService {
  async recompute(capability, providerKey) {
    const secret = secretStatus(capability, providerKey);
    const cfg = await dbProviderConfigSource.get(capability, providerKey);
    const attempts = await R.recentAttempts(capability, providerKey, WINDOW_MS);
    const prev = await R.health(capability, providerKey);

    const total = attempts.length;
    const failures = attempts.filter((a) => a.outcome === 'FAILURE');
    const authFailures = failures.filter((a) => AUTH_CODES.has(a.normalized_error_code));
    const successes = attempts.filter((a) => a.outcome === 'SUCCESS');
    const unknowns = attempts.filter((a) => a.outcome === 'UNKNOWN');
    const lastSuccessAt = successes[0]?.started_at ?? null;
    const lastFailureAt = failures[0]?.started_at ?? null;
    const durations = attempts.map((a) => a.duration_ms).filter((d) => d != null);
    const avgLatencyMs = durations.length ? Math.round(durations.reduce((s, d) => s + Number(d), 0) / durations.length) : null;
    const errorRatioBps = total ? Math.round((failures.length / total) * 10000) : null;

    let status;
    let reason;
    if (secret === 'NOT_CONFIGURED') { status = 'NOT_CONFIGURED'; reason = 'required credentials are absent from the environment'; }
    else if (secret === 'PARTIAL') { status = 'MISCONFIGURED'; reason = 'some credentials are missing'; }
    else if (total === 0) { status = 'UNKNOWN'; reason = 'no recent operational evidence'; }
    else if (authFailures.length && authFailures.length === failures.length && successes.length === 0) {
      status = 'MISCONFIGURED'; reason = 'every recent attempt failed provider authentication — the credentials appear invalid';
    }
    else if (successes.length === 0 && unknowns.length === 0) { status = 'UNAVAILABLE'; reason = 'no successful attempt in the window'; }
    else if (failures.length / total >= 0.5) { status = 'DEGRADED'; reason = `error ratio ${(errorRatioBps / 100).toFixed(0)}%`; }
    else { status = 'HEALTHY'; reason = `recent success rate ${(100 - errorRatioBps / 100).toFixed(0)}%`; }

    if (!cfg.enabled && status === 'HEALTHY') reason += ' (provider is disabled for new operations)';

    await R.upsertHealth({
      capability, providerKey, status, secretStatus: secret,
      lastSuccessAt, lastFailureAt, errorRatioBps, avgLatencyMs,
      detail: { window: '24h', attempts: total, failures: failures.length, authFailures: authFailures.length, unknowns: unknowns.length, enabled: cfg.enabled, reason },
    });
    if (!prev || prev.status !== status) {
      await R.recordHealthEvent(capability, providerKey, prev?.status ?? null, status, reason);
      await alertStaff({ capability, providerKey, from: prev?.status ?? null, to: status, reason, enabled: Boolean(cfg.enabled) });
    }
    return { capability, providerKey, status, secretStatus: secret, reason, lastSuccessAt, lastFailureAt, avgLatencyMs, errorRatioBps };
  }

  async recomputeAll() {
    const out = [];
    for (const d of PROVIDERS) out.push(await this.recompute(d.capability, d.providerKey));
    return out;
  }

  async overview() {
    const [configs, health] = await Promise.all([dbProviderConfigSource.list(), R.allHealth()]);
    const healthByKey = new Map(health.map((h) => [`${h.capability}:${h.provider_key}`, h]));
    return PROVIDERS.map((d) => {
      const cfg = configs.find((c) => c.capability === d.capability && c.providerKey === d.providerKey) || {};
      const h = healthByKey.get(`${d.capability}:${d.providerKey}`);
      return {
        capability: d.capability, providerKey: d.providerKey, label: d.label, webhookCapable: d.webhookCapable,
        enabled: Boolean(cfg.enabled), priority: cfg.priority ?? null, configVersion: cfg.version ?? 0, configSource: cfg.source ?? 'DEFAULT',
        secretStatus: secretStatus(d.capability, d.providerKey),
        health: h?.status ?? 'UNKNOWN',
        lastSuccessAt: h?.last_success_at ?? null, lastFailureAt: h?.last_failure_at ?? null,
        avgLatencyMs: h?.avg_latency_ms ?? null, recentErrorRatioBps: h?.recent_error_ratio_bps ?? null,
      };
    });
  }

  detail(capability, providerKey) {
    return Promise.all([R.health(capability, providerKey), R.healthEvents(capability, providerKey)])
      .then(([h, events]) => ({
        health: h ? { status: h.status, secretStatus: h.secret_status, lastSuccessAt: h.last_success_at, lastFailureAt: h.last_failure_at, avgLatencyMs: h.avg_latency_ms, recentErrorRatioBps: h.recent_error_ratio_bps, detail: h.detail_json } : null,
        events,
      }));
  }
}

export const providerHealthService = new ProviderHealthService();
