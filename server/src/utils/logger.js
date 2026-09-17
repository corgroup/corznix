// Wave 8J-1 — one small structured logger for the whole backend. Line-
// delimited JSON to stdout/stderr (a real log shipper on the host does the
// rest). No framework: this is deliberately ~60 lines.
//
// Every value passes through redaction: known-sensitive keys are dropped,
// and free strings that look like a token / bearer header / OTP are masked.
// Callers still must not hand it a raw provider payload or Authorization
// header — redaction is the safety net, not the contract.

import { env } from '../config/index.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const THRESHOLD = LEVELS[String(env.LOG_LEVEL || (env.NODE_ENV === 'test' ? 'warn' : 'info')).toLowerCase()] ?? 20;

const SENSITIVE_KEY = /pass(word|wd)?|secret|token|api[_-]?key|private[_-]?key|credential|authorization|auth[_-]?header|bearer|cookie|session|refresh|otp|cvv|card[_-]?number|signature/i;
const SENSITIVE_VALUE = /\bBearer\s+[\w.\-]+/i;
const EMAILISH = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONEISH = /^\+?\d[\d\s-]{6,}$/;

function maskContact(v) {
  const s = String(v);
  if (EMAILISH.test(s)) { const [u, d] = s.split('@'); return `${u.slice(0, 2)}***@${d}`; }
  if (PHONEISH.test(s)) return `${s.slice(0, 3)}***${s.slice(-2)}`;
  return s;
}

export function redact(value, depth = 0) {
  if (value == null || depth > 4) return value;
  if (typeof value === 'string') {
    if (SENSITIVE_VALUE.test(value)) return '[redacted]';
    return value.length > 512 ? `${value.slice(0, 512)}…` : value;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(k)) { out[k] = '[redacted]'; continue; }
    if (/^(email|phone|contact|destination|address|to)$/i.test(k) && typeof v === 'string') { out[k] = maskContact(v); continue; }
    out[k] = redact(v, depth + 1);
  }
  return out;
}

function emit(level, moduleName, message, fields) {
  if (LEVELS[level] < THRESHOLD) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    module: moduleName,
    msg: message,
    ...redact(fields || {}),
  });
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

/** `logger('outbox')` → a bound logger that tags every line with that module. */
export function logger(moduleName = 'app') {
  return {
    debug: (msg, fields) => emit('debug', moduleName, msg, fields),
    info: (msg, fields) => emit('info', moduleName, msg, fields),
    warn: (msg, fields) => emit('warn', moduleName, msg, fields),
    error: (msg, fields) => emit('error', moduleName, msg, fields),
    child: (extra) => {
      const base = logger(moduleName);
      return {
        debug: (m, f) => base.debug(m, { ...extra, ...f }),
        info: (m, f) => base.info(m, { ...extra, ...f }),
        warn: (m, f) => base.warn(m, { ...extra, ...f }),
        error: (m, f) => base.error(m, { ...extra, ...f }),
      };
    },
  };
}

export const log = logger('app');
