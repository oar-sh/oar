'use strict';

/**
 * Shared helpers for working with `ask_user` / elicitation `requestedSchema`
 * forms. Used by the relay server and the web UI (via a browser copy of the same
 * logic) so single- and multi-field structured forms
 * are handled consistently.
 *
 * A requestedSchema follows a restricted subset of JSON Schema:
 *   {
 *     "type": "object",
 *     "properties": {
 *       "<field>": {
 *         "type": "string" | "boolean" | "number" | "integer" | "array",
 *         "title": "...", "description": "...", "default": ...,
 *         "enum": [...],                       // string choices
 *         "oneOf": [{ "const": v, "title": l }],// labelled choices
 *         "format": "email" | "uri" | ...,
 *         "items": { ... }                      // for arrays (enum / anyOf)
 *       }
 *     },
 *     "required": ["field1", ...]
 *   }
 */

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text || (text[0] !== '{' && text[0] !== '[')) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

/**
 * Return true when a request carries a requestedSchema, even when the schema
 * is invalid. Callers use this to avoid treating a failed structured request
 * as a legacy text prompt while the SDK validates or retries it.
 */
export function containsRequestedSchema(source) {
  if (!source) return false;
  const seen = new Set();
  const queue = [source];
  let depth = 0;
  while (queue.length && depth < 5000) {
    depth += 1;
    const current = parseMaybeJson(queue.shift());
    if (!isPlainObject(current)) continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (current.requestedSchema !== undefined) return true;
    for (const key of [
      'toolArgs', 'arguments', 'args', 'input', 'payload', 'body', 'request',
      'toolInput', 'toolCall', 'data',
    ]) {
      if (current[key] !== undefined) queue.push(current[key]);
    }
  }
  return false;
}

/**
 * Locate a `requestedSchema` object inside an arbitrary request/toolArgs shape.
 * Returns the normalized schema object or null.
 */
export function extractRequestedSchema(source) {
  if (!source) return null;
  const seen = new Set();
  const queue = [source];
  let depth = 0;
  while (queue.length && depth < 5000) {
    depth += 1;
    const current = parseMaybeJson(queue.shift());
    if (!isPlainObject(current)) continue;
    if (seen.has(current)) continue;
    seen.add(current);
    const candidate = parseMaybeJson(current.requestedSchema);
    if (isPlainObject(candidate) && isPlainObject(candidate.properties)) {
      return normalizeSchema(candidate);
    }
    for (const key of [
      'toolArgs', 'arguments', 'args', 'input', 'payload', 'body', 'request',
      'toolInput', 'toolCall', 'data',
    ]) {
      if (current[key] !== undefined) queue.push(current[key]);
    }
  }
  return null;
}

/** Normalize a raw schema (parsing JSON strings, ensuring shape). */
export function normalizeSchema(raw) {
  const schema = parseMaybeJson(raw);
  if (!isPlainObject(schema) || !isPlainObject(schema.properties)) return null;
  const required = Array.isArray(schema.required)
    ? schema.required.map((name) => String(name)).filter(Boolean)
    : [];
  return {
    type: 'object',
    properties: schema.properties,
    required,
  };
}

function normalizeChoice(entry) {
  if (typeof entry === 'string') {
    const value = entry.trim();
    return value ? { value, label: value } : null;
  }
  if (isPlainObject(entry)) {
    const value = entry.const !== undefined ? entry.const : (entry.value !== undefined ? entry.value : entry.title);
    if (value === undefined || value === null) return null;
    const label = String(entry.title || entry.label || entry.description || value).trim();
    return { value, label: label || String(value) };
  }
  return null;
}

function fieldChoices(prop) {
  const out = [];
  if (Array.isArray(prop?.enum)) {
    for (const e of prop.enum) {
      const c = normalizeChoice(e);
      if (c) out.push(c);
    }
  }
  if (Array.isArray(prop?.oneOf)) {
    for (const e of prop.oneOf) {
      const c = normalizeChoice(e);
      if (c) out.push(c);
    }
  }
  // Array item choices (multi-select)
  const items = prop?.items;
  if (isPlainObject(items)) {
    if (Array.isArray(items.enum)) {
      for (const e of items.enum) {
        const c = normalizeChoice(e);
        if (c) out.push(c);
      }
    }
    if (Array.isArray(items.anyOf)) {
      for (const e of items.anyOf) {
        const c = normalizeChoice(e);
        if (c) out.push(c);
      }
    }
  }
  // Deduplicate by value
  const seen = new Set();
  return out.filter((c) => {
    const key = String(c.value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Return an ordered list of normalized field descriptors for a schema.
 */
export function schemaFields(schema) {
  const normalized = normalizeSchema(schema);
  if (!normalized) return [];
  const requiredSet = new Set(normalized.required);
  const fields = [];
  for (const [name, rawProp] of Object.entries(normalized.properties)) {
    const prop = parseMaybeJson(rawProp);
    if (!isPlainObject(prop)) continue;
    const type = String(prop.type || 'string').toLowerCase();
    const choices = fieldChoices(prop);
    fields.push({
      name,
      type,
      title: String(prop.title || name).trim() || name,
      description: String(prop.description || '').trim(),
      required: requiredSet.has(name),
      hasDefault: Object.prototype.hasOwnProperty.call(prop, 'default'),
      default: prop.default,
      choices,
      isMultiSelect: type === 'array',
      format: String(prop.format || '').trim() || null,
    });
  }
  return fields;
}

/** True when the schema describes more than one field. */
export function isMultiFieldSchema(schema) {
  return schemaFields(schema).length > 1;
}

function coerceValue(field, rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return { present: false, value: undefined };
  }
  switch (field.type) {
    case 'boolean': {
      if (typeof rawValue === 'boolean') return { present: true, value: rawValue };
      const text = String(rawValue).trim().toLowerCase();
      if (['true', 'yes', '1', 'on'].includes(text)) return { present: true, value: true };
      if (['false', 'no', '0', 'off'].includes(text)) return { present: true, value: false };
      return { present: true, value: undefined, error: 'expected boolean' };
    }
    case 'number':
    case 'integer': {
      const num = Number(rawValue);
      if (!Number.isFinite(num)) return { present: true, value: undefined, error: 'expected number' };
      if (field.type === 'integer' && !Number.isInteger(num)) {
        return { present: true, value: Math.trunc(num) };
      }
      return { present: true, value: num };
    }
    case 'array': {
      let arr = rawValue;
      if (typeof rawValue === 'string') {
        arr = rawValue.split(',').map((s) => s.trim()).filter(Boolean);
      }
      if (!Array.isArray(arr)) return { present: true, value: undefined, error: 'expected array' };
      return { present: true, value: arr.map((v) => (typeof v === 'string' ? v.trim() : v)) };
    }
    default: {
      return { present: true, value: String(rawValue) };
    }
  }
}

function choiceMatches(field, value) {
  if (!field.choices.length) return true;
  const allowed = field.choices.map((c) => String(c.value));
  if (field.type === 'array') {
    const list = Array.isArray(value) ? value : [value];
    return list.every((v) => allowed.includes(String(v)));
  }
  return allowed.includes(String(value));
}

/**
 * Validate and coerce a structured answer object against the schema.
 * Returns { ok, errors: [{field, message}], value: {field: coerced} }.
 */
export function validateStructuredAnswer(schema, answer) {
  const fields = schemaFields(schema);
  const errors = [];
  const value = {};
  const source = isPlainObject(answer) ? answer : {};

  for (const field of fields) {
    let raw = source[field.name];
    const coerced = coerceValue(field, raw);

    if (!coerced.present) {
      if (field.hasDefault) {
        value[field.name] = field.default;
        continue;
      }
      if (field.required) {
        errors.push({ field: field.name, message: `${field.title} is required` });
      }
      continue;
    }

    if (coerced.error) {
      errors.push({ field: field.name, message: `${field.title}: ${coerced.error}` });
      continue;
    }

    if (!choiceMatches(field, coerced.value)) {
      errors.push({ field: field.name, message: `${field.title}: value not allowed` });
      continue;
    }

    value[field.name] = coerced.value;
  }

  return { ok: errors.length === 0, errors, value };
}

/** Render a structured answer object as a short human-readable string. */
export function summarizeStructuredAnswer(schema, answer) {
  const fields = schemaFields(schema);
  const source = isPlainObject(answer) ? answer : {};
  const parts = [];
  const ordered = fields.length ? fields.map((f) => f.name) : Object.keys(source);
  for (const name of ordered) {
    if (!(name in source)) continue;
    const field = fields.find((f) => f.name === name);
    const label = field ? field.title : name;
    let val = source[name];
    if (Array.isArray(val)) val = val.join(', ');
    parts.push(`${label}: ${val}`);
  }
  return parts.join(' · ');
}

/**
 * Build a structured content object from a single flat string answer.
 * Used for backward compatibility / single-field schemas where the relay only
 * captured one string. Maps the answer onto the schema's single field.
 */
export function flatAnswerToStructured(schema, flatAnswer) {
  const fields = schemaFields(schema);
  if (fields.length !== 1) return null;
  const field = fields[0];
  const coerced = coerceValue(field, flatAnswer);
  if (!coerced.present || coerced.error) return null;
  if (!choiceMatches(field, coerced.value)) return null;
  return { [field.name]: coerced.value };
}
