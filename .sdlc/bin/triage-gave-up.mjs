#!/usr/bin/env node
// The failure triage itself failed. Say so on the issue and stop.
//
// Triaging a triage failure is an infinite regress with a model bill attached, so this is the
// one failure in the pipeline that nothing diagnoses. A person gets the two run links and the
// stage name, which is all anyone needs to start looking.
//
// A script rather than a shell heredoc in the workflow: a multi-line comment body inside a
// YAML block scalar has to be indented to stay inside it, and getting that wrong breaks the
// whole workflow file rather than just this message.
import { gh } from './lib/actions.js';

const { ISSUE: issue, STAGE: stage, RUN_URL: runUrl, FAILED_URL: failedUrl } = process.env;

await gh(['issue', 'comment', String(issue), '--body', [
  '## The failure triage itself failed',
  '',
  `The \`${stage}\` stage failed on this issue, and the agent dispatched to diagnose that`,
  'failure did not finish either. Nothing has been re-run: triaging a triage failure is an',
  'infinite regress, so this stops here.',
  '',
  `[The triage run](${runUrl}) · [the run it was reading](${failedUrl})`,
  '',
  `\`/sdlc retry ${stage}\` runs the stage again if you believe the failure was transient.`,
].join('\n')]).catch((e) => process.stdout.write(`::warning::${e.message}\n`));
