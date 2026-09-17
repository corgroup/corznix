import { REPORT_TIMEZONE } from './metricDefinitions.js';

// Asia/Kolkata is a fixed UTC+05:30 (no DST) — a constant offset is exact.
const IST_OFFSET_MIN = 330;
const DAY_MS = 86400000;

const toIst = (date) => new Date(date.getTime() + IST_OFFSET_MIN * 60000);
const fromIst = (date) => new Date(date.getTime() - IST_OFFSET_MIN * 60000);
// Floor a UTC instant to IST-midnight, returned as the equivalent UTC instant.
const istDayStart = (date) => {
  const ist = toIst(date);
  ist.setUTCHours(0, 0, 0, 0);
  return fromIst(ist);
};

export const RANGES = ['today', 'yesterday', 'last_7_days', 'last_30_days', 'month_to_date', 'custom'];

/**
 * Resolve a named range to canonical UTC boundaries [start, end) computed in
 * the business timezone (§14/§15) — no UTC-midnight bugs.
 * @returns {{ range, timezone, start: Date, end: Date, label: string, previous: {start:Date,end:Date} }}
 */
export function resolvePeriod({ range = 'last_7_days', start = null, end = null, now = new Date() } = {}) {
  const todayStart = istDayStart(now);
  let s;
  let e = new Date(todayStart.getTime() + DAY_MS); // end of today (exclusive)

  switch (range) {
    case 'today': s = todayStart; break;
    case 'yesterday': s = new Date(todayStart.getTime() - DAY_MS); e = todayStart; break;
    case 'last_7_days': s = new Date(todayStart.getTime() - 6 * DAY_MS); break;
    case 'last_30_days': s = new Date(todayStart.getTime() - 29 * DAY_MS); break;
    case 'month_to_date': {
      const ist = toIst(now); ist.setUTCDate(1); ist.setUTCHours(0, 0, 0, 0);
      s = fromIst(ist); break;
    }
    case 'custom': {
      if (!start || !end) throw Object.assign(new Error('custom range needs start and end (YYYY-MM-DD)'), { status: 400, code: 'VALIDATION_ERROR' });
      const parse = (d) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw Object.assign(new Error('dates must be YYYY-MM-DD'), { status: 400, code: 'VALIDATION_ERROR' });
        return fromIst(new Date(`${d}T00:00:00.000Z`));
      };
      s = parse(start);
      e = new Date(parse(end).getTime() + DAY_MS);
      if (e <= s) throw Object.assign(new Error('end must be on or after start'), { status: 400, code: 'VALIDATION_ERROR' });
      if (e - s > 400 * DAY_MS) throw Object.assign(new Error('range too large — export instead'), { status: 400, code: 'RANGE_TOO_LARGE' });
      break;
    }
    default:
      throw Object.assign(new Error(`unknown range "${range}"`), { status: 400, code: 'VALIDATION_ERROR' });
  }

  const span = e - s;
  return {
    range,
    timezone: REPORT_TIMEZONE,
    start: s,
    end: e,
    label: `${istIso(s)} → ${istIso(new Date(e.getTime() - 1))}`,
    previous: { start: new Date(s.getTime() - span), end: s },
  };
}

const istIso = (date) => toIst(date).toISOString().slice(0, 10);

// A day-bucket expression for time series: convert the canonical column to IST,
// then take the date. Column name is caller-controlled (never user input).
export const istDateExpr = (col) => `DATE(CONVERT_TZ(${col}, '+00:00', '+05:30'))`;
