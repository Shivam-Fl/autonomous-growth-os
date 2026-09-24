// Minimal JSON-Schema-subset validator. No dependencies.
//
// Deliberately FAILS CLOSED: a schema keyword this validator does not implement
// throws instead of being skipped. A validator that silently ignores what it does
// not understand is worse than none at all — it reports "valid" for data it never
// actually checked, and this sits on the trust boundary between agents.

const ANNOTATIONS = new Set(['$id', '$schema', 'title', 'description', 'examples', 'default']);
// No maxLength and no maxItems: an artifact is never refused for how much it says. A cap that
// creeps back into a schema is refused here as unsupported, and by a test before it ships.
const KEYWORDS = new Set([
  'type', 'required', 'additionalProperties', 'properties', 'items',
  'minItems', 'enum', 'pattern', 'minLength',
  'minimum', 'maximum',
]);

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function assertKnown(schema, at) {
  for (const k of Object.keys(schema)) {
    if (!ANNOTATIONS.has(k) && !KEYWORDS.has(k)) {
      throw new Error(`unsupported schema keyword "${k}" at ${at || '(root)'} — refusing to validate`);
    }
  }
}

function walk(schema, data, path, errors) {
  assertKnown(schema, path);
  const t = typeOf(data);
  const err = (message) => errors.push({ path: path || '(root)', message });

  if (schema.type !== undefined) {
    // One type, or a list of them: `["string", "null"]` is a field that may say "none" out loud
    // rather than by being absent, which a reader cannot tell apart from "not known".
    const wants = [].concat(schema.type);
    const want = wants.join(' or ');
    const ok = wants.some((w) => (w === 'integer' ? Number.isInteger(data) : t === w));
    if (!ok) {
      // Show the VALUE, not just its type.
      //
      // "`confidence`: expected integer, got string" sent an issue to a human, and the
      // work-order.json it came from lived only on the runner's ephemeral filesystem — so the
      // agent dispatched to diagnose it could say what the type was and never what the value
      // was. "got string \"high\"" is a fix; "got string" is an invitation to guess.
      const shown = typeof data === 'string' || typeof data === 'number' || typeof data === 'boolean'
        ? ` ${JSON.stringify(String(data).slice(0, 80))}`
        : '';
      err(`expected ${want}, got ${t === 'number' && wants.includes('integer') ? 'non-integer number' : t}${shown}`);
      return; // every other check assumes the type held
    }
  }

  if (schema.enum !== undefined && !schema.enum.includes(data)) {
    err(`must be one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(data)}`);
  }

  if (t === 'string') {
    if (schema.minLength !== undefined && data.length < schema.minLength) {
      err(`shorter than minLength ${schema.minLength} (got ${data.length})`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(data)) {
      err(`does not match pattern ${schema.pattern}`);
    }
  }

  if (t === 'number') {
    if (schema.minimum !== undefined && data < schema.minimum) err(`below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && data > schema.maximum) err(`above maximum ${schema.maximum}`);
  }

  if (t === 'array') {
    if (schema.minItems !== undefined && data.length < schema.minItems) {
      err(`needs at least ${schema.minItems} item(s), got ${data.length}`);
    }
    if (schema.items !== undefined) {
      data.forEach((item, i) => walk(schema.items, item, `${path}[${i}]`, errors));
    }
  }

  if (t === 'object') {
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) err(`missing required property "${key}"`);
    }
    const props = schema.properties || {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(data)) {
        if (!Object.prototype.hasOwnProperty.call(props, key)) err(`unexpected property "${key}"`);
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        walk(sub, data[key], path ? `${path}.${key}` : key, errors);
      }
    }
  }
}

/** @returns {{ok: true} | {ok: false, errors: {path: string, message: string}[]}} */
export function validate(schema, data) {
  const errors = [];
  walk(schema, data, '', errors);
  return errors.length ? { ok: false, errors } : { ok: true };
}

/** Human-readable one-error-per-line summary, for posting back to GitHub. */
export function formatErrors(errors) {
  return errors.map((e) => `- \`${e.path}\`: ${e.message}`).join('\n');
}
