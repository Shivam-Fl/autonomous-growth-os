// Dispatch the next stage, and make a failure to do so impossible to miss.
//
// These calls were written `.catch(() => {})`, the same as cleanup — and they are not cleanup.
// A swallowed dispatch leaves a stage that succeeded, a ledger that moved, a label that says
// work is in flight, and nothing running. That is this pipeline's signature failure: you find
// out by noticing that nothing happened, hours later, with no red run to look at.
//
// The one legitimate reason to continue is a fresh install, where the workflow does not exist
// on the default branch yet — dispatch.mjs already detects that and exits cleanly, so anything
// reaching here is a real failure.

import { gh } from './actions.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

/**
 * @param {string} workflow  e.g. 'sdlc-implement.yml'
 * @param {string[]} args    e.g. ['-f', 'issue=42']
 * @param {{issue?: string|number, pr?: string|number, why: string}} ctx
 * @returns {Promise<boolean>} whether the next stage was started
 */
export async function handOff(workflow, args, { issue, pr, why }) {
  try {
    await exec('node', ['.sdlc/bin/dispatch.mjs', workflow, ...args]);
    return true;
  } catch (e) {
    const detail = String(e.stderr || e.message).trim().split('\n').slice(-2).join(' ');
    const body =
      `## The pipeline stopped here\n\n` +
      `\`${workflow}\` should have started next — ${why} — and the dispatch failed:\n\n` +
      '```\n' + detail + '\n```\n\n' +
      'Nothing else is running on this. Everything up to this point stands; only the hand-off ' +
      'failed, so re-running that workflow by hand continues from here rather than redoing the ' +
      'work.';

    // Say it where someone is looking, not only in a log nobody opens.
    const target = issue ?? pr;
    if (target) await gh(['issue', 'comment', String(target), '--body', body]).catch(() => {});
    process.stdout.write(`::error::could not dispatch ${workflow}: ${detail}\n`);
    return false;
  }
}
