import { AppError } from '../../utils/errors.js';

// Wave 8G-7 §128/§129 — safe template rendering.
//
// Templates use a restricted `{{ variable }}` placeholder syntax — no
// expressions, no code. Every placeholder must be declared in the template's
// `variable_schema`; a message can never silently render `undefined`, a raw
// object, or unescaped customer input.

const PLACEHOLDER = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

const escapeHtml = (s) => String(s)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

/** Collect the distinct placeholder names used in a template string. */
export function placeholdersIn(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(PLACEHOLDER)) out.add(m[1]);
  return [...out];
}

/**
 * Validate `variables` against `schema` and render `text`.
 * @param {string} text
 * @param {Record<string,{required?:boolean,type?:string}>} schema
 * @param {Record<string,unknown>} variables
 * @param {{ channel: 'EMAIL'|'WHATSAPP' }} opts
 */
export function renderTemplate(text, schema, variables, { channel }) {
  const used = placeholdersIn(text);
  for (const name of used) {
    if (!Object.prototype.hasOwnProperty.call(schema, name)) {
      throw new AppError('TEMPLATE_VARIABLE_INVALID', `Template uses "{{${name}}}" which is not in its variable schema.`, 400);
    }
  }
  for (const [name, def] of Object.entries(schema)) {
    const provided = Object.prototype.hasOwnProperty.call(variables, name);
    if (def.required && !provided) {
      throw new AppError('TEMPLATE_VARIABLE_INVALID', `Required variable "${name}" is missing.`, 400);
    }
    if (!provided) continue;
    const value = variables[name];
    if (value === undefined || value === null) {
      throw new AppError('TEMPLATE_VARIABLE_INVALID', `Variable "${name}" resolved to ${value}.`, 400);
    }
    if (typeof value === 'object') {
      throw new AppError('TEMPLATE_VARIABLE_INVALID', `Variable "${name}" is an object — templates render scalars only.`, 400);
    }
    if (def.type === 'number' && typeof value !== 'number') {
      throw new AppError('TEMPLATE_VARIABLE_INVALID', `Variable "${name}" must be a number.`, 400);
    }
  }

  const rendered = String(text).replace(PLACEHOLDER, (_, name) => {
    const raw = variables[name];
    // An OPTIONAL variable that the caller did not supply renders as nothing.
    // It used to render the literal text "undefined" — String(undefined) —
    // so any template with an optional placeholder could put that word in
    // front of a customer. The validation above already rejects a null or
    // undefined value for a variable that WAS supplied, so this only covers
    // the legitimately-absent case.
    const value = raw === undefined || raw === null ? '' : raw;
    // EMAIL bodies are HTML — escape. WhatsApp is plain text via an approved
    // provider template, so no HTML escaping, but still a scalar only.
    return channel === 'EMAIL' ? escapeHtml(value) : String(value);
  });
  return rendered;
}
