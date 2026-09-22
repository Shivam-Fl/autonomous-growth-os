// Fix what is mechanically fixable, before deciding anything is wrong.
//
// A plan council — three agents, twenty minutes of model work — was thrown away because one
// prose string came out 513 characters against a 500 limit. The pipeline was correct by its
// own rules and useless in practice, and the same shape had already cost a root-cause run and
// a QA run.
//
// The rule I had applied everywhere, "fail closed, loudly", is right for a CLAIM: a verdict
// with no evidence, a work order touching a reserved path, a `next_action` nobody can route.
// It is wrong for a LIMIT. Length caps, array caps and stray fields exist to keep artifacts
// readable, and nothing downstream breaks if a sentence is trimmed — whereas discarding the
// whole artifact breaks everything downstream by definition.
//
// So: repair the cosmetic, then validate the rest. What gets repaired is reported, because a
// silent trim is how a limit becomes invisible and then meaningless.

const ELLIPSIS = '…';

/**
 * @returns {{data: any, repairs: string[]}} the document with cosmetic violations corrected
 */
export function repair(schema, data, path = '') {
  const repairs = [];
  const at = (k) => (path ? `${path}.${k}` : String(k));

  const walk = (sch, val, where) => {
    if (!sch || val === null || val === undefined) return val;

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
      // Entries are repaired; the LIST is never shortened.
      //
      // This used to keep the first N and drop the rest, which is indefensible for the arrays
      // these schemas actually hold: `bugs`, `tests`, `acceptance_rollup`, `files`. Dropping
      // the 61st bug from a QA report produces a report that passes its own consistency check
      // and no longer says what the agent found — a silent edit to a merge decision.
      //
      // Trimming a sentence loses wording. Trimming a list loses findings. An over-long list
      // is rare, always meaningful, and the agent is now told the cap up front, so overflow
      // fails loudly and is re-emitted rather than quietly becoming a shorter truth.
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

    if (sch.type === 'string' && typeof val === 'string') {
      if (typeof sch.maxLength === 'number' && val.length > sch.maxLength) {
        repairs.push(`${where}: trimmed from ${val.length} to ${sch.maxLength} characters`);
        // Cut at a word boundary where one is near the end, so the trim reads as an edit
        // rather than as corruption.
        const cut = val.slice(0, sch.maxLength - ELLIPSIS.length);
        const space = cut.lastIndexOf(' ');
        // `> 0` matters: lastIndexOf returns -1 when there is no space at all, and -1 clears
        // any negative threshold, which silently cut one more character than intended.
        const atWord = space > 0 && space > cut.length - 60;
        return (atWord ? cut.slice(0, space) : cut) + ELLIPSIS;
      }
      return val;
    }

    return val;
  };

  return { data: walk(schema, data, path), repairs };
}
