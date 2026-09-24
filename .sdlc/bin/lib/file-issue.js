// File an issue, and start it only when asked.
//
// Two places in this framework open issues for findings that are real but out of the current
// PR's scope: QA, for bugs it did not cause, and review, for non-blocking findings nobody
// fixed; post-work-order files a deferred split criterion the same way. Both existed because
// "a finding recorded in prose nobody actions is a finding that was not made" — and both then
// produced issues that no stage ever picked up.
//
// GitHub will not trigger a workflow from an event its own GITHUB_TOKEN caused, and an issue
// created by a workflow fires no `issues: [opened]` event. So an issue filed here is either
// dispatched to intake (`start`) or labelled `sdlc:blocked` with a `Depends on #n` line, which
// wake-dependents re-offers a slot under limits.max_in_flight. Every caller now does the second:
// starting at once put work in flight past the cap and outside the split's dependency order.
// So the default is that queued path, `sdlc:blocked` and no start: `sdlc:triage` unstarted is an
// in-flight label nothing runs, and a caller that passes start: true bypasses the cap.
//
// One helper, because the bug was written twice and the second time was by someone who had
// read the first.

import { gh } from './actions.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * @param {{title: string, body: string, labels?: string[], start?: boolean}} spec
 * @returns {Promise<{number: number, labelled: boolean, started: boolean} | null>}
 */
export async function fileIssue({ title, body, labels = ['sdlc:blocked'], start = false }) {
  let labelled = true;
  let url = await gh(['issue', 'create', '--title', title, '--body', body,
    '--label', labels.join(',')]).catch(() => null);

  if (!url) {
    // A label this repo does not have must not lose the finding. Report it unlabelled and
    // say so, rather than failing and leaving nothing.
    labelled = false;
    url = await gh(['issue', 'create', '--title', title, '--body', body]).catch(() => null);
  }
  if (!url) return null;

  const number = Number(String(url).trim().split('/').pop());
  if (!Number.isInteger(number)) return null;

  let started = false;
  if (start) {
    // Intake decides what this needs, the same as for an issue a person opened. Dispatch
    // rather than trusting the label: the `issues: [opened]` event never fired.
    started = await exec('node', ['.sdlc/bin/dispatch.mjs', 'sdlc-intake.yml', '-f', `issue=${number}`])
      .then(() => true)
      .catch((e) => {
        process.stdout.write(`::warning::filed #${number} but could not start it: ${String(e.message).split('\n')[0]}\n`);
        return false;
      });
  }
  return { number, labelled, started };
}
