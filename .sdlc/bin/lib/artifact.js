// Load an agent's artifact the one way every script that ACTS on it must: repaired, then
// validated, never trusted as written.
//
// `sdlc-ctl validate` does this as a workflow step, and the scripts that act on verdicts —
// apply-plan-review, apply-triage, post-review, start-split-issues — read the file themselves.
// Nothing made the step precede the read, so a triage.json saying "Escalate" or a plan review
// saying "Approve" was routed on exact string compares that did not match, and the fallback
// branch decided instead of the agent. Loading through here, a script cannot skip validation.
//
// And a rejected artifact is kept. It lived only on the runner, so the rerun started from
// nothing — eight minutes of research, or a three-agent council — to fix one field.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repair } from './repair.js';
import { validate } from './validate.js';
import { updateLedger } from './state-io.js';

/**
 * @returns {{ok: boolean, data: any, raw: string|null, errors: string[], repairs: string[]}}
 *          never throws and never exits: what to do about a bad artifact is the caller's call
 */
export function loadArtifact(schemaName, file, { root = process.env.SDLC_ROOT ?? process.cwd() } = {}) {
  const fail = (errors, raw = null, data = null) => ({ ok: false, data, raw, errors, repairs: [] });
  if (!existsSync(file)) return fail([`${file} was not written`]);
  let raw;
  let data;
  try {
    raw = readFileSync(file, 'utf8');
    data = JSON.parse(raw);
  } catch (e) {
    return fail([`not JSON: ${e.message}`], raw ?? null);
  }
  try {
    const schema = JSON.parse(readFileSync(join(root, '.sdlc', 'schemas', `${schemaName}.json`), 'utf8'));
    const fixed = repair(schema, data);
    const v = validate(schema, fixed.data);
    return {
      ok: v.ok, data: fixed.data, raw,
      errors: v.ok ? [] : v.errors.map((e) => `\`${e.path}\`: ${e.message}`),
      repairs: fixed.repairs,
    };
  } catch (e) {
    // A missing schema or a keyword the validator refuses: the artifact was not checked, so it
    // is not valid.
    return fail([e.message], raw, data);
  }
}

/** Keep a rejected artifact on the ledger, so the rerun corrects it instead of starting over. */
export async function rememberRejected(repo, issue, schemaName, raw, errors = [], { run = process.env.GITHUB_RUN_ID } = {}) {
  try {
    await updateLedger(repo, Number(issue), (l) => (l ? {
      ...l,
      rejected_artifacts: {
        ...(l.rejected_artifacts ?? {}),
        [schemaName]: {
          text: String(raw ?? '').slice(0, 60000), errors: errors.slice(0, 20),
          run: run ?? null, at: new Date().toISOString(),
        },
      },
    } : null));
  } catch (e) {
    // The rejection itself is what matters to the caller; losing the copy costs a rerun only.
    process.stdout.write(`::warning::could not keep the rejected ${schemaName} for issue #${issue}: ${e.message}\n`);
  }
}
