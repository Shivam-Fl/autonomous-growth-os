// Fix what is mechanically fixable, before deciding anything is wrong.
//
// "Fail closed, loudly" is right for a CLAIM: a verdict with no evidence, a work order touching
// a reserved path, a `next_action` nobody can route. It is wrong for a REPRESENTATION — the
// right number wearing quotes, an enum in the wrong case, a field the schema never asked for.
// Discarding the whole artifact over one of those breaks everything downstream by definition.
//
// Length is not repaired, because nothing is limited by it: the schemas carry no length or
// count caps. They were trimmed here and rejected there, and between them threw away a plan
// council, a root-cause run, a QA run and a project brief — each correct, each discarded for
// how much it said. GitHub's own limits on a title or a body are met where the text is posted,
// in gh() (lib/actions.js), not by making the artifact shorter.
//
// So: repair the representation, then validate the rest. What gets repaired is reported,
// because a silent repair is how a rule becomes invisible.

const scalar = (v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/**
 * @returns {{data: any, repairs: string[]}} the document with representation slips corrected
 */
export function repair(schema, data, path = '') {
  const repairs = [];
  const at = (k) => (path ? `${path}.${k}` : String(k));

  const walk = (schema, val, where) => {
    if (!schema || val === null || val === undefined) return val;
    // A nullable field is repaired as the one type it takes besides null — a null has already
    // returned above. A union of two real types is left alone: which one was meant is a guess.
    const types = [].concat(schema.type ?? []).filter((t) => t !== 'null');
    const sch = { ...schema, type: types.length === 1 ? types[0] : undefined };

    // Follow the one composition keyword the schemas actually use. Anything else is left to
    // the validator, which is fail-closed about keywords it does not implement.
    if (Array.isArray(sch.anyOf ?? sch.oneOf)) return val;

    if (sch.type === 'object' && typeof val === 'object' && !Array.isArray(val)) {
      const out = {};
      for (const [k, v] of Object.entries(val)) {
        const propSchema = sch.properties?.[k];
        if (!propSchema) {
          // An extra field is the agent saying more than the schema asked for. Dropping it
          // costs nothing; refusing the document costs the whole run.
          if (sch.additionalProperties === false) {
            repairs.push(`${where ? `${where}.` : ''}${k}: dropped (not in the schema)`);
            continue;
          }
          out[k] = v;
          continue;
        }
        out[k] = walk(propSchema, v, where ? `${where}.${k}` : k);
      }
      return out;
    }

    if (sch.type === 'array' && Array.isArray(val)) {
      // Entries are repaired; the list is never shortened. Dropping the 61st bug from a QA report
      // leaves a report that passes its own consistency check and no longer says what was found.
      return val.map((v, i) => walk(sch.items, v, `${where}[${i}]`));
    }

    // --- representation, not meaning ----------------------------------------
    //
    // `"confidence": "95"` where the schema says integer stopped a route dead and sent the
    // issue to a human. The value is not wrong, ambiguous, or missing — it is the right
    // number wearing quotes, and a system that can plan a feature and drive a browser should
    // not be defeated by that.
    //
    // Only where the reading is the ONLY possible reading. `"high"` is not a confidence and
    // `"95.7"` is not an integer — those are claims the agent got wrong, and they still fail.
    if (sch.type === 'integer' && typeof val === 'string' && /^-?\d+$/.test(val.trim())) {
      repairs.push(`${where}: "${val}" read as the integer ${Number(val)}`);
      return Number(val.trim());
    }
    if (sch.type === 'number' && typeof val === 'string' && /^-?\d+(\.\d+)?$/.test(val.trim())) {
      repairs.push(`${where}: "${val}" read as the number ${Number(val)}`);
      return Number(val.trim());
    }
    if (sch.type === 'boolean' && typeof val === 'string' && /^(true|false)$/i.test(val.trim())) {
      repairs.push(`${where}: "${val}" read as the boolean ${val.trim().toLowerCase()}`);
      return val.trim().toLowerCase() === 'true';
    }
    if (sch.type === 'string' && (typeof val === 'number' || typeof val === 'boolean')) {
      repairs.push(`${where}: ${val} read as the string "${val}"`);
      return String(val);
    }

    // A list, or a flat record, where one string was asked for.
    //
    // `trd.interfaces[].errors` is described as "what the caller sees when it fails", and a
    // planner answered `["400 invalid_payload", "409 duplicate_event_id"]` — the natural shape
    // for a plural. It was the same shape as the `ui.layouts[].states` failure already fixed
    // once, and it lost a whole project brief the same way. Every entry is kept, one per line;
    // only a list of scalars qualifies, because nesting is a shape the reader would have to guess.
    if (sch.type === 'string' && val && typeof val === 'object') {
      const entries = Array.isArray(val) ? val : Object.entries(val);
      const flat = Array.isArray(val) ? val.every(scalar) : entries.every(([, v]) => scalar(v));
      if (entries.length && flat) {
        repairs.push(`${where}: ${Array.isArray(val) ? 'a list' : 'a record'} of ${entries.length} read as one line each`);
        val = Array.isArray(val) ? val.join('\n') : entries.map(([k, v]) => `${k}: ${v}`).join('\n');
      }
    }

    // One value where a list was asked for. The commonest JSON slip there is, and the
    // intended reading is not in doubt — an agent that names one file meant a list of one.
    if (sch.type === 'array' && !Array.isArray(val) && typeof val !== 'object') {
      repairs.push(`${where}: a single value wrapped into a list of one`);
      return walk(sch.items, val, `${where}[0]`) !== undefined
        ? [walk(sch.items, val, `${where}[0]`)]
        : [val];
    }

    // An enum value whose only fault is its capitals. Enums are closed sets, so there is
    // exactly one thing "Approve" can mean when the set holds "approve".
    if (Array.isArray(sch.enum) && typeof val === 'string' && !sch.enum.includes(val)) {
      const hit = sch.enum.find((e) => typeof e === 'string'
        && e.toLowerCase() === val.trim().toLowerCase());
      if (hit) {
        repairs.push(`${where}: "${val}" read as "${hit}"`);
        return hit;
      }
    }

    return val;
  };

  return { data: walk(schema, data, path), repairs };
}
