#!/usr/bin/env node
// Dispatches the next stage, and explains the one failure every first install hits.
//
// `workflow_dispatch` only works for a workflow that exists on the DEFAULT branch. On the PR
// that installs this framework, none of them do yet — so every hand-off 404s. That is
// expected and temporary, but a bare 404 makes the install PR look broken and sends people
// debugging a pipeline that is working correctly.

import { gh, setOutput, die } from './lib/actions.js';

const workflow = process.argv[2] ?? die('usage: dispatch.mjs <workflow.yml> [--flag value ...]');
const rest = process.argv.slice(3);

try {
  await gh(['workflow', 'run', workflow, ...rest]);
  setOutput('dispatched', 'true');
  process.stdout.write(`dispatched ${workflow}\n`);
} catch (e) {
  const msg = String(e.stderr ?? e.message);
  if (/not found on the default branch/i.test(msg)) {
    process.stdout.write(
      `${workflow} is not on the default branch yet, so it cannot be dispatched.\n\n` +
      'This is expected while the framework is still on a pull request: GitHub only allows\n' +
      'workflow_dispatch for workflows that exist on the default branch. Merge the install PR\n' +
      'and the hand-off works from the next issue onward. Nothing is misconfigured.\n');
    setOutput('dispatched', 'false');
    setOutput('reason', 'not-on-default-branch');
    process.exit(0);          // not a failure — do not redden a PR over it
  }
  die(`could not dispatch ${workflow}: ${msg.split('\n')[0]}`);
}
