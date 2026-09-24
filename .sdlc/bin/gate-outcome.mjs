#!/usr/bin/env node
// Moves the ledger on the gate's result, and posts a digest when the PR is red.
import { gh, ghJson, die, setOutput, loadConfig, repo as repoOf } from './lib/actions.js';
import { advance } from './lib/advance.js';
import { handOffNext } from './lib/route-io.js';
import { readLedger, updateLedger } from './lib/state-io.js';

const pr = process.env.PR;
// Read explicitly, and refuse to guess.
//
// This read `process.env.PASSED ?? process.env.CONCLUSION === 'success'` from a step that
// passed neither, so it evaluated to false and labelled every PR ci-red — green checks
// included, every time. Defaulting to a verdict when the outcome is unknown is the bug
// family this pipeline keeps producing: absent silently becoming a value nobody chose.
//
// `none` is a verdict too: wait-for-checks found no gating check on a repo whose verify.mode
// says there is no CI to wait for. The gate skipped this step on it, and nothing else hands
// off, so every PR on such a repo stopped at the gate with a green run and nothing scheduled.
const conclusion = process.env.CONCLUSION ?? '';
if (!['success', 'failure', 'none'].includes(conclusion)) {
  die(`CONCLUSION is "${conclusion || '(unset)'}" — refusing to mark a PR red or green on a ` +
      'guess. The gate step must pass steps.checks.outputs.conclusion through as env.');
}
const passed = conclusion !== 'failure';
const detail = await ghJson(['pr', 'view', pr, '--json', 'body']);
const issue = (detail.body ?? '').match(/(?:closes|fixes|resolves)\s+#(\d+)/i)?.[1];
if (!issue) { process.stdout.write(`PR #${pr} closes no issue — nothing to record\n`); process.exit(0); }
const repo = repoOf();

// Both labels present is worse than neither — advance() drops every state label but this one.
try {
  await advance(issue, passed ? 'ci-green' : 'ci-red', { agent: 'gate' });
} catch (e) {
  // A person stopped this issue. Recording nothing and starting nothing is the answer, not a
  // crash for the failure handler to diagnose.
  if (!/halted by @/.test(e.message)) throw e;
  process.stdout.write(`${e.message}\n`);
  setOutput('next', '');
  process.exit(0);
}
if (!passed) { setOutput('next', ''); process.exit(0); }   // the red path is the self-heal loop's

// A route without a review was decided on the ticket's TITLE, before any code existed: "typo",
// "rename" and "copy" route plan -> implement -> qa, and so can a model router. Nothing ever
// compared that claim with what was built, so a forty-file diff on a "trivial" route went
// straight to QA and an unattended merge. This is the first point where the diff exists.
const { ledger } = await readLedger(repo, issue).catch(() => ({ ledger: null }));
const route = ledger?.planned_route ?? [];
if (route.includes('implement') && !route.includes('review')) {
  const cfg = await loadConfig();
  const maxLines = Number(cfg.route?.trivial_max_lines ?? 30);
  const maxFiles = Number(cfg.route?.trivial_max_files ?? 2);
  const size = await ghJson(['pr', 'view', pr, '--json', 'additions,deletions,files']);
  const lines = (size.additions ?? 0) + (size.deletions ?? 0);
  const files = (size.files ?? []).length;
  if (lines > maxLines || files > maxFiles) {
    const why = `PR #${pr} changes ${lines} line(s) in ${files} file(s), over the ${maxLines}-line, ` +
      `${maxFiles}-file ceiling for a route without review`;
    await updateLedger(repo, issue, (l) => {
      const r = l?.planned_route ?? [];
      if (!l || r.includes('review') || !r.includes('implement')) return null;
      const at = r.indexOf('implement') + 1;
      return {
        ...l,
        planned_route: [...r.slice(0, at), 'review', ...r.slice(at)],
        history: [...(l.history ?? []), { at: new Date().toISOString(), agent: 'gate',
          action: `review added to the route: ${why}` }].slice(-200),
      };
    });
    await gh(['issue', 'comment', String(issue), '--body',
      '## A review was added to this route\n\n' +
      `This ticket was routed without one, on a reading made before any code existed. ${why} ` +
      '(`route.trivial_max_lines` / `route.trivial_max_files`), so a reviewer reads it before QA does.'])
      .catch((e) => process.stdout.write(`::warning::could not say why review was added: ${e.message}\n`));
    process.stdout.write(`review added to the route: ${why}\n`);
  }
}

// Green. What runs next is the ROUTE's decision, not a filename written here.
//
// It was the review workflow's filename, written into the gate, which is right for most
// tickets and wrong for the ones that do not need a review — and there was no way for a
// ticket to say so, because the chain was the code.
const { stage } = await handOffNext({
  repo, issue, pr, from: 'gate', agent: 'gate',
  why: conclusion === 'none' ? 'nothing gates this PR and verify.mode asks for nothing'
                             : 'the checks that gate this PR have passed',
});
setOutput('next', stage ?? '');
