import { AppError } from '../../utils/errors.js';

/**
 * Whitelisted segment-rule compiler (Wave 8G-5 §85-87).
 *
 * A segment definition is `{ match: 'ALL'|'ANY', conditions: [ { attribute,
 * operator, value, ... } ] }`. Nothing here ever interpolates a caller value
 * into SQL — every value becomes a bound `?` parameter. An attribute or
 * operator outside the registry is rejected before any SQL is built, so
 * `ARBITRARY_SEGMENT_SQL` is structurally impossible.
 */

const NUMERIC_OPS = ['EQ', 'NE', 'GT', 'GTE', 'LT', 'LTE'];
const DATE_OPS = ['EQ', 'NE', 'BEFORE', 'AFTER'];
const SET_OPS = ['EQ', 'NE', 'IN', 'NOT_IN'];

const SQL_OP = {
  EQ: '=', NE: '<>', GT: '>', GTE: '>=', LT: '<', LTE: '<=',
  BEFORE: '<', AFTER: '>',
};

const isPlainDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$/.test(v);
const isId = (v) => typeof v === 'string' && /^[0-9a-fA-F-]{36}$/.test(v);

// Each builder returns { expr, params }. `expr` is a boolean SQL fragment over
// the alias `c` (customers). Correlated sub-selects keep the top query flat.
const REGISTRY = {
  created_at: {
    valueType: 'date', operators: DATE_OPS,
    build: (op, value) => ({ expr: `c.created_at ${SQL_OP[op]} ?`, params: [value] }),
  },
  customer_status: {
    valueType: 'enum', enum: ['PENDING_PROFILE', 'ACTIVE', 'SUSPENDED'], operators: SET_OPS,
    build: (op, value) => setExpr('c.status', op, value),
  },
  order_count: {
    valueType: 'int', operators: NUMERIC_OPS,
    build: (op, value) => ({
      expr: `(SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id) ${SQL_OP[op]} ?`,
      params: [value],
    }),
  },
  paid_order_count: {
    valueType: 'int', operators: NUMERIC_OPS,
    build: (op, value) => ({
      expr: `(SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id AND o.payment_status = 'PAID') ${SQL_OP[op]} ?`,
      params: [value],
    }),
  },
  lifetime_spend_minor: {
    valueType: 'int', operators: NUMERIC_OPS,
    build: (op, value) => ({
      expr: `(SELECT COALESCE(SUM(o.total_minor), 0) FROM orders o WHERE o.customer_id = c.id AND o.payment_status IN ('PAID','COD_DUE')) ${SQL_OP[op]} ?`,
      params: [value],
    }),
  },
  last_order_at: {
    valueType: 'date', operators: DATE_OPS,
    build: (op, value) => ({
      // NULL (never ordered) is never >, <, or = a date — matches intent.
      expr: `(SELECT MAX(o.placed_at) FROM orders o WHERE o.customer_id = c.id) ${SQL_OP[op]} ?`,
      params: [value],
    }),
  },
  shipping_state: {
    valueType: 'string', operators: SET_OPS,
    build: (op, value) => existsSet('SELECT 1 FROM addresses a WHERE a.customer_id = c.id AND a.state', op, value),
  },
  shipping_country: {
    valueType: 'string', operators: SET_OPS,
    build: (op, value) => existsSet('SELECT 1 FROM addresses a WHERE a.customer_id = c.id AND a.country', op, value),
  },
  has_purchased_category: {
    valueType: 'id', operators: ['EQ', 'IN'],
    build: (op, value) => existsSet(
      `SELECT 1 FROM order_items oi
         JOIN orders o ON o.id = oi.order_id AND o.customer_id = c.id
         JOIN products p ON p.id = oi.product_id
         LEFT JOIN product_categories pc ON pc.product_id = p.id
        WHERE COALESCE(pc.category_id, p.category_id)`, op === 'EQ' ? 'EQ' : 'IN', value),
  },
  has_purchased_collection: {
    valueType: 'id', operators: ['EQ', 'IN'],
    build: (op, value) => existsSet(
      `SELECT 1 FROM order_items oi
         JOIN orders o ON o.id = oi.order_id AND o.customer_id = c.id
         JOIN product_collections pcol ON pcol.product_id = oi.product_id
        WHERE pcol.collection_id`, op === 'EQ' ? 'EQ' : 'IN', value),
  },
  newsletter_subscribed: {
    valueType: 'bool', operators: ['EQ'],
    build: (op, value) => ({
      expr: `${value ? '' : 'NOT '}EXISTS (SELECT 1 FROM newsletter_subscribers ns WHERE ns.customer_id = c.id AND ns.status = 'SUBSCRIBED')`,
      params: [],
    }),
  },
  marketing_consent: {
    valueType: 'bool', operators: ['EQ'], requiresChannelPurpose: true,
    build: (op, value, cond) => ({
      // GRANTED for (channel, purpose) AND the granting endpoint is not
      // currently suppressed — the same gate the send path uses (§91).
      expr: `${value ? '' : 'NOT '}EXISTS (
        SELECT 1 FROM consent_state cs
         WHERE cs.customer_id = c.id AND cs.channel = ? AND cs.purpose = ? AND cs.effective_action = 'GRANTED'
           AND NOT EXISTS (
             SELECT 1 FROM marketing_suppressions ms
              WHERE ms.contact_key = cs.contact_key AND ms.channel = cs.channel AND ms.released_at IS NULL))`,
      params: [cond.channel, cond.purpose],
    }),
  },
};

function setExpr(column, op, value) {
  if (op === 'IN' || op === 'NOT_IN') {
    const arr = value;
    return { expr: `${column} ${op === 'IN' ? 'IN' : 'NOT IN'} (${arr.map(() => '?').join(', ')})`, params: [...arr] };
  }
  return { expr: `${column} ${SQL_OP[op]} ?`, params: [value] };
}

function existsSet(innerSelectEndingBeforeOperator, op, value) {
  if (op === 'IN' || op === 'NOT_IN') {
    const arr = value;
    const placeholders = arr.map(() => '?').join(', ');
    const negate = op === 'NOT_IN' ? 'NOT ' : '';
    return { expr: `${negate}EXISTS (${innerSelectEndingBeforeOperator} IN (${placeholders}))`, params: [...arr] };
  }
  if (op === 'NE') {
    return { expr: `NOT EXISTS (${innerSelectEndingBeforeOperator} = ?)`, params: [value] };
  }
  // EQ
  return { expr: `EXISTS (${innerSelectEndingBeforeOperator} = ?)`, params: [value] };
}

export function attributeRegistry() {
  return Object.entries(REGISTRY).map(([key, def]) => ({
    attribute: key,
    valueType: def.valueType,
    operators: def.operators,
    ...(def.enum ? { enum: def.enum } : {}),
    ...(def.requiresChannelPurpose ? { requiresChannelPurpose: true } : {}),
  }));
}

function validateValue(attr, def, op, value) {
  const many = op === 'IN' || op === 'NOT_IN';
  if (many) {
    if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
      throw new AppError('SEGMENT_RULE_INVALID', `"${attr}" ${op} needs a non-empty array (max 50).`, 400);
    }
    value.forEach((v) => validateScalar(attr, def, v));
    return;
  }
  validateScalar(attr, def, value);
}

function validateScalar(attr, def, value) {
  switch (def.valueType) {
    case 'int':
      if (!Number.isInteger(value) || value < 0) throw new AppError('SEGMENT_RULE_INVALID', `"${attr}" needs a non-negative integer.`, 400);
      break;
    case 'date':
      if (!isPlainDate(value)) throw new AppError('SEGMENT_RULE_INVALID', `"${attr}" needs an ISO date (YYYY-MM-DD).`, 400);
      break;
    case 'bool':
      if (typeof value !== 'boolean') throw new AppError('SEGMENT_RULE_INVALID', `"${attr}" needs a boolean.`, 400);
      break;
    case 'id':
      if (!isId(value)) throw new AppError('SEGMENT_RULE_INVALID', `"${attr}" needs an id.`, 400);
      break;
    case 'enum':
      if (!def.enum.includes(value)) throw new AppError('SEGMENT_RULE_INVALID', `"${attr}" must be one of ${def.enum.join(', ')}.`, 400);
      break;
    case 'string':
      if (typeof value !== 'string' || value.length === 0 || value.length > 120) {
        throw new AppError('SEGMENT_RULE_INVALID', `"${attr}" needs a short string.`, 400);
      }
      break;
    default:
      throw new AppError('SEGMENT_RULE_INVALID', `Unknown value type for "${attr}".`, 400);
  }
}

/** Validate a raw definition and normalize it (no SQL yet). Throws AppError('SEGMENT_RULE_INVALID'). */
export function validateDefinition(raw) {
  if (!raw || typeof raw !== 'object') throw new AppError('SEGMENT_RULE_INVALID', 'A segment definition object is required.', 400);
  const match = raw.match ?? 'ALL';
  if (match !== 'ALL' && match !== 'ANY') throw new AppError('SEGMENT_RULE_INVALID', 'match must be ALL or ANY.', 400);
  const conditions = raw.conditions;
  if (!Array.isArray(conditions) || conditions.length === 0 || conditions.length > 20) {
    throw new AppError('SEGMENT_RULE_INVALID', 'A segment needs 1-20 conditions.', 400);
  }
  const normalized = conditions.map((cond, i) => {
    if (!cond || typeof cond !== 'object') throw new AppError('SEGMENT_RULE_INVALID', `Condition ${i + 1} is malformed.`, 400);
    const def = Object.prototype.hasOwnProperty.call(REGISTRY, cond.attribute) ? REGISTRY[cond.attribute] : null;
    if (!def) throw new AppError('SEGMENT_RULE_INVALID', `Unknown attribute "${cond.attribute}".`, 400);
    if (!def.operators.includes(cond.operator)) {
      throw new AppError('SEGMENT_RULE_INVALID', `Operator "${cond.operator}" is not allowed for "${cond.attribute}".`, 400);
    }
    validateValue(cond.attribute, def, cond.operator, cond.value);
    const out = { attribute: cond.attribute, operator: cond.operator, value: cond.value };
    if (def.requiresChannelPurpose) {
      if (!['EMAIL', 'WHATSAPP'].includes(cond.channel) || !['MARKETING', 'NEWSLETTER'].includes(cond.purpose)) {
        throw new AppError('SEGMENT_RULE_INVALID', `"${cond.attribute}" needs channel (EMAIL|WHATSAPP) and purpose (MARKETING|NEWSLETTER).`, 400);
      }
      out.channel = cond.channel;
      out.purpose = cond.purpose;
    }
    return out;
  });
  return { match, conditions: normalized };
}

/**
 * Compile a (already validated or raw) definition into a parameterized query.
 * @returns {{ where: string, params: any[], selectIds: string, selectCount: string }}
 */
export function compile(rawDefinition) {
  const def = validateDefinition(rawDefinition);
  const parts = [];
  const params = [];
  for (const cond of def.conditions) {
    const built = REGISTRY[cond.attribute].build(cond.operator, cond.value, cond);
    parts.push(`(${built.expr})`);
    params.push(...built.params);
  }
  const glue = def.match === 'ALL' ? ' AND ' : ' OR ';
  const where = parts.join(glue);
  return {
    where,
    params,
    selectIds: `SELECT c.id FROM customers c WHERE ${where}`,
    selectCount: `SELECT COUNT(*) AS n FROM customers c WHERE ${where}`,
  };
}
