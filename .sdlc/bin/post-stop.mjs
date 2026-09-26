#!/usr/bin/env node
// An agent that says "I cannot plan / reproduce / fix this" — posted, parked, resumable.
//
// The packs told a planner, a debugger or root-cause that could not honestly produce its
// artifact to write nothing, comment, and label the issue needs-human. That is the contract
// working, and the pipeline read it as a crash: the next step failed on a missing
// work-order.json, the failure handler said the planner had broken and dispatched it again, and
// root-cause's `next_action: escalate` — a field the work-order schema does not have — was
// dropped by repair and the plan it came with was posted and built. So stopping is an artifact
// of its own, stop.json, and a script does everything that follows from it.
import { gh, setOutput, die, isPipelineAuthor, repo as repoOf } from './lib/actions.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadArtifact } from './lib/artifact.js';
import { markResume } from './lib/route-io.js';
import { advance } from './lib/advance.js';
import { retryHint } from './lib/flow-graph.js';

const issue = process.env.ISSUE ?? die('ISSUE is required');
const stage = process.env.FROM_STAGE ?? die('FROM_STAGE is required (the stage that stopped)');

// Invalid is a failed run, not a stop: the failure path reruns the agent with the errors.
const loaded = loadArtifact('stop', 'stop.json');
if (!loaded.ok) die(`stop.json cannot be acted on: ${loaded.errors.join('; ')}`);
const { kind, reason } = loaded.data;

// The agent's words, posted under the pipeline's name — so quoted. Readers of the pipeline's own
// comments take a fenced JSON block there as a failure packet or a work order, and the stop is
// the one place an agent picks every word of a comment: a `reason` carrying such a block was
// read back as the pipeline's. `<!--` too, because the work-order marker is matched anywhere.
const quote = (s) => String(s ?? '').replace(/<!--/g, '&lt;!--').split('\n').map((l) => `> ${l}`).join('\n');

const unblock = {
  'cannot-reproduce': 'Add what it takes to see the bug — the account, the data, the exact steps — ' +
    'then `/sdlc approve` runs this stage again.',
  'needs-decision': '`/sdlc answer "<the decision>"` records it where every stage reads it and runs this stage again.',
  environmental: `Fix what is named above, then ${retryHint(stage)} — no code change was proposed for it.`,
  'cannot-plan': '`/sdlc answer "<what was missing>"` runs this stage again with it; ' +
    '`/sdlc replan "<why>"` re-routes the issue instead.',
  'already-done': 'If that is right, close this issue; if something is still missing, `/sdlc answer "<what>"` runs this stage again.',
}[kind];

// Where to resume first, so a person who reads the comment and acts immediately finds it set.
// Nothing left to build. growth-os #47 — three bugs QA had filed, each reproduced by the planner
// against main and found already fixed — waited for a person to agree there was nothing to do.
// A ticket the pipeline filed itself closes on that evidence (reopening it runs it again); one a
// person filed still waits for them to say so.
if (kind === 'already-done') {
  const login = await gh(['api', `repos/${repoOf()}/issues/${issue}`, '--jq', '.user.login']).then((l) => l.trim()).catch(() => '');
  if (isPipelineAuthor(login)) {
    await gh(['issue', 'comment', issue, '--body',
      `## Already done — closing\n\n\`${stage}\` checked every change this asks for against the default branch, ` +
      `and none is left to make:\n\n${quote(reason)}\n\n_Reopen it if that is wrong, and it runs again._`]);
    await promisify(execFile)('node', ['.sdlc/bin/sdlc-ctl.mjs', 'reconcile', '--issue', String(issue), '--to', 'done',
      '--agent', stage, '--observed', 'already done on the default branch']).catch((e) =>
      process.stdout.write(`::warning::could not record it as done: ${e.message}\n`));
    await advance(issue, 'done', { agent: stage }).catch(() => {});
    await gh(['issue', 'close', issue, '--reason', 'completed']).catch(() => {});
    setOutput('stopped', 'true');
    process.stdout.write(`issue #${issue}: already done — closed\n`);
    process.exit(0);
  }
}

await markResume(repoOf(), issue, stage, 'retry');
await gh(['issue', 'comment', issue, '--body',
  `## \`${stage}\` stopped: ${kind}\n\n${quote(reason)}\n\n${unblock}\n\n` +
  '_Stopping is this agent working, not failing: nothing was guessed at, and nothing runs on ' +
  'this issue until a person answers._']);
await advance(issue, 'needs-human', { agent: stage });
setOutput('stopped', 'true');
process.stdout.write(`issue #${issue}: ${stage} stopped (${kind}) — waiting for a person\n`);
