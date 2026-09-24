#!/usr/bin/env node
// Render a schema's constraints as something an agent can actually follow.
//
// A plan council spent twenty minutes producing a work order and the pipeline discarded it
// because one string was 513 characters against a limit of 500. The agent was never told the
// limit existed. Nothing in the pack, nothing in the prompt — the constraint lived only in the
// validator that rejected the result.
//
// A limit nobody is told about is not a constraint, it is a trap. This prints the caps and
// allowed values straight from the schema, so the prompt carries them and they cannot drift
// from what is enforced.

import { readFileSync } from 'node:fs';
import { setOutput, die } from './lib/actions.js';

const name = process.argv[2] ?? process.env.SCHEMA ?? die('usage: schema-limits.mjs <schema-name>');
const root = new URL('../schemas/', import.meta.url).pathname;
const schema = JSON.parse(readFileSync(`${root}${name}.json`, 'utf8'));

const lines = [];

const describe = (sch, path) => {
  if (!sch || typeof sch !== 'object') return;

  const caps = [];

  // The TYPE, and the range a number has to sit in.
  //
  // This printed lengths, counts, enums and patterns — and never once said what type a field
  // had to be. So `confidence` was described to the planner by nothing at all, and three runs
  // across two repos died on `expected integer, got string`: once as "95" and once as a float.
  // Every time, a planner that had done its whole job correctly lost the work order at the
  // final step, over a constraint that appeared in no prompt and no pack.
  //
  // Only for scalars. Saying "object" or "array" adds noise where the shape line below already
  // says it better, and `string` is the default assumption an agent already makes — so this
  // speaks up exactly where getting it wrong is silent and fatal.
  if (sch.type === 'integer' || sch.type === 'number' || sch.type === 'boolean') {
    const range = typeof sch.minimum === 'number' && typeof sch.maximum === 'number'
      ? ` from ${sch.minimum} to ${sch.maximum}`
      : typeof sch.minimum === 'number' ? ` of at least ${sch.minimum}`
      : typeof sch.maximum === 'number' ? ` of at most ${sch.maximum}`
      : '';
    const unquoted = sch.type === 'boolean' ? 'true or false, unquoted' : `${sch.type}${range}, unquoted`;
    caps.push(`a JSON ${unquoted}`);
  }

  if (typeof sch.maxLength === 'number') caps.push(`at most ${sch.maxLength} characters`);
  if (typeof sch.minLength === 'number' && sch.minLength > 1) caps.push(`at least ${sch.minLength} characters`);
  const entries = (n) => `${n} ${n === 1 ? 'entry' : 'entries'}`;
  if (typeof sch.maxItems === 'number') caps.push(`at most ${entries(sch.maxItems)}`);
  if (typeof sch.minItems === 'number' && sch.minItems > 0) caps.push(`at least ${entries(sch.minItems)}`);
  if (Array.isArray(sch.enum)) caps.push(`one of: ${sch.enum.join(' | ')}`);
  if (sch.pattern) caps.push(`matching ${sch.pattern}`);
  if (caps.length && path) lines.push(`- \`${path}\` — ${caps.join(', ')}`);

  if (sch.type === 'object' && sch.properties) {
    // The SHAPE of each object, at every depth — not just the root's.
    //
    // This printed the required keys for the top level only, so an agent was told `files` and
    // `acceptance` are required and nothing at all about what one ENTRY of either looks like.
    // Root-cause on tabs #11 then put `cases` (a tests[] field) into a files[] entry and left
    // out the required `change`: repair dropped the stray field correctly and refused to
    // invent the missing one correctly, and the run died on a shape the prompt never stated.
    //
    // Two arrays of objects in one schema is all it takes. Name the keys per entry.
    const keys = Object.keys(sch.properties);
    const req = sch.required ?? [];
    const opt = keys.filter((k) => !req.includes(k));
    const shape =
      `required: ${req.join(', ') || '(none)'}` +
      (opt.length ? ` \u00b7 optional: ${opt.join(', ')}` : '') +
      (sch.additionalProperties === false ? ' \u00b7 nothing else; extra fields are dropped' : '');

    if (path === '') lines.unshift(`- top level \u2014 ${shape}`);
    else lines.push(`- \`${path}\` \u2014 ${shape}`);

    for (const [k, v] of Object.entries(sch.properties)) describe(v, path ? `${path}.${k}` : k);
  }
  if (sch.type === 'array') {
    // A skeleton of one entry, for arrays of objects.
    //
    // "required: path, action, change" is a list of key names, and a model copies a shape. Two
    // arrays of objects in one schema is all it takes to confuse them: a planner put `cases`
    // — a tests[] key — into a files[] entry and left out the required `change`, twice in a
    // row, against a prompt that named both key sets correctly. A shape it can copy is a
    // stronger instruction than a list it has to assemble.
    const it = sch.items;
    if (it?.type === 'object' && it.properties && path) {
      const req = it.required ?? Object.keys(it.properties).slice(0, 4);
      const stub = (k) => {
        const t = it.properties[k]?.type;
        if (Array.isArray(it.properties[k]?.enum)) return JSON.stringify(it.properties[k].enum[0]);
        // The skeleton must itself be valid. `0` was printed for every number, and QA's
        // `network_failures[].status` is 100-599 — so the prompt literally showed a value the
        // validator rejects, next to a line saying it would.
        if (t === 'integer' || t === 'number') return String(it.properties[k].minimum ?? 0);
        if (t === 'boolean') return 'false';
        if (t === 'array') return '[…]';
        if (t === 'object') return '{…}';
        return '"…"';
      };
      if (req.length) {
        lines.push(`- \`${path}[]\` — each entry looks like: ` +
          `\`{${req.map((k) => `"${k}": ${stub(k)}`).join(', ')}}\``);
      }
    }
    describe(it, `${path}[]`);
  }
};

describe(schema, '');

const out = lines.join('\n');
process.stdout.write(`${out}\n`);
setOutput('limits', out);
