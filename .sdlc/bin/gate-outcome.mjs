#!/usr/bin/env node
// Moves the ledger on the gate's result, and posts a digest when the PR is red.
import { ghJson, die, setOutput, repo as repoOf } from './lib/actions.js';
import { advance } from './lib/advance.js';
import { handOffNext } from './lib/route-io.js';

const pr = process.env.PR;
// Read explicitly, and refuse to guess.
//
// This read `process.env.PASSED ?? process.env.CONCLUSION === 'success'` from a step that
// passed neither, so it evaluated to false and labelled every PR ci-red — green checks
// included, every time. Defaulting to a verdict when the outcome is unknown is the bug
// family this pipeline keeps producing: absent silently becoming a value nobody chose.
const conclusion = process.env.CONCLUSION ?? '';
if (!['success', 'failure'].includes(conclusion)) {
  die(`CONCLUSION is "${conclusion || '(unset)'}" — refusing to mark a PR red or green on a ` +
      'guess. The gate step must pass steps.checks.outputs.conclusion through as env.');
}
const passed = conclusion === 'success';
const detail = await ghJson(['pr', 'view', pr, '--json', 'body']);
const issue = (detail.body ?? '').match(/(?:closes|fixes|resolves)\s+#(\d+)/i)?.[1];
if (!issue) { process.stdout.write(`PR #${pr} closes no issue — nothing to record\n`); process.exit(0); }

// Both labels present is worse than neither — advance() drops every state label but this one.
await advance(issue, passed ? 'ci-green' : 'ci-red', { agent: 'gate' });
if (!passed) { setOutput('next', ''); process.exit(0); }   // the red path is the self-heal loop's

// Green. What runs next is the ROUTE's decision, not a filename written here.
//
// It was the review workflow's filename, written into the gate, which is right for most
// tickets and wrong for the ones that do not need a review — and there was no way for a
// ticket to say so, because the chain was the code.
const { stage } = await handOffNext({
  repo: repoOf(), issue, pr, from: 'gate', agent: 'gate',
  why: 'the checks that gate this PR have passed',
});
setOutput('next', stage ?? '');
