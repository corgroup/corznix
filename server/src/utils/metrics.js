// Wave 8J-1 — a tiny in-process metrics seam. No Prometheus client, no
// external stack: just counters + latency summaries that `/api/v1/admin/
// ops/metrics` renders as JSON. A host-level scraper can be pointed at that
// route later. Values reset on process restart (documented).

const counters = new Map();
const summaries = new Map();

const keyOf = (name, labels) => (labels && Object.keys(labels).length
  ? `${name}{${Object.entries(labels).sort().map(([k, v]) => `${k}=${v}`).join(',')}}`
  : name);

export function increment(name, labels, by = 1) {
  const k = keyOf(name, labels);
  counters.set(k, (counters.get(k) || 0) + by);
}

export function observe(name, ms, labels) {
  const k = keyOf(name, labels);
  let s = summaries.get(k);
  if (!s) { s = { count: 0, sum: 0, max: 0, buckets: [] }; summaries.set(k, s); }
  s.count += 1; s.sum += ms; s.max = Math.max(s.max, ms);
  s.buckets.push(ms);
  if (s.buckets.length > 2000) s.buckets.splice(0, s.buckets.length - 2000);
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

export function snapshot() {
  const out = { counters: {}, latency: {}, capturedAt: new Date().toISOString(), sinceProcessStart: true };
  for (const [k, v] of counters) out.counters[k] = v;
  for (const [k, s] of summaries) {
    const sorted = [...s.buckets].sort((a, b) => a - b);
    out.latency[k] = { count: s.count, avgMs: Math.round(s.sum / s.count), p50Ms: Math.round(pct(sorted, 50)), p95Ms: Math.round(pct(sorted, 95)), maxMs: Math.round(s.max) };
  }
  return out;
}

export function resetMetrics() { counters.clear(); summaries.clear(); }
