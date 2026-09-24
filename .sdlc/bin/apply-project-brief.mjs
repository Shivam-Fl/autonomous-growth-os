#!/usr/bin/env node
// Turns an approved-shape project brief into the files every later agent reads, on a PR.
//
// Mechanical, so a script does it. The brief is a decision; writing four files, numbering the
// ADRs and opening a pull request is not, and an instruction a model can satisfy in more than
// one way is eventually satisfied the other way.
//
// It always ends at a human. `gates.plan_approval` is a config flag; this gate is not one and
// cannot be switched off. Architecture is the most expensive decision here to reverse — a
// wrong stack is discovered on ticket nine, after eight implementations have assumed it — and
// a person reads it exactly once per repository.

import { renderPrd, renderTrd, renderUi, renderResearch } from './lib/render-docs.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gh, ghJson, setOutput, die, isPipelineAuthor, repo as repoOf } from './lib/actions.js';
import { advance } from './lib/advance.js';
import { renderProjectMd, renderAdr, indexWithDocs, renderConventions, qaStub, isStub, uncoveredSections } from './lib/project.js';
import { markResume } from './lib/route-io.js';
import { readLedger, updateLedger } from './lib/state-io.js';
import { rememberRejected } from './lib/artifact.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const run = (cmd, args) => exec(cmd, args).then((r) => r.stdout.trim());

const issue = process.env.ISSUE ?? die('ISSUE is required');
const brief = JSON.parse(readFileSync('project-brief.json', 'utf8'));
const branch = `sdlc/project-${issue}`;
const today = new Date().toISOString().slice(0, 10);

// --- the whole spec, or no brief ---------------------------------------------
// Every numbered section has a disposition — scope, requirement, non-goal, deferred — before
// anything is written. A spec compressed into a capped brief lost whatever did not fit, and the
// one person reading this gate could not see what was missing. The index comes from the job
// that numbered the spec, not from the agent's checkout, so the brief cannot redraw it.
const specIndex = existsSync('spec-index.json')
  ? JSON.parse(readFileSync('spec-index.json', 'utf8'))
  : die('spec-index.json was not handed over, so nothing can say this brief covers the spec');
const uncovered = uncoveredSections(brief, specIndex);
if (uncovered.length) {
  const errors = [`\`coverage\`: no disposition for ${uncovered.map((s) => `${s.id} ("${s.title}")`).join(', ')}`];
  await rememberRejected(repoOf(), issue, 'project-brief', readFileSync('project-brief.json', 'utf8'), errors);
  die(`the brief does not account for the whole spec — ${errors[0]}. Every section needs scope, ` +
    'requirement, non_goal or deferred; the rejected brief is kept for the rerun to correct.');
}

// --- the files ---------------------------------------------------------------
mkdirSync('.sdlc/memory/decisions', { recursive: true });
const firstBrief = isStub(existsSync('.sdlc/memory/project.md') ? readFileSync('.sdlc/memory/project.md', 'utf8') : null);
writeFileSync('.sdlc/memory/project.md', renderProjectMd(brief));

// The rest of what install seeded from the FRAMEWORK's own memory: its Node house rules, and QA
// notes and selectors for its todo demo (`#new-todo`, `demo.todos`). The implementer followed
// those rules, the reviewer checked drift against them and QA reached for those selectors, in a
// product the brief had just decided was something else. Replaced here, in the same PR.
//
// The QA notes only on the first brief. After that they are what QA learned about this product,
// and a pivot through `/sdlc replan-project` changes the stack, not the login recipe.
writeFileSync('.sdlc/memory/conventions.md', renderConventions(brief, { issue }));
if (firstBrief) {
  mkdirSync('.sdlc/memory/qa', { recursive: true });
  writeFileSync('.sdlc/memory/qa/selectors.md', qaStub('Stable selectors',
    'QA adds selectors here as it finds ones that survive copy and layout changes.'));
  writeFileSync('.sdlc/memory/qa/environment.md', qaStub('QA environment notes',
    'QA adds the preview environment\'s quirks, login recipes and flaky spots here after each run.'));
}

// Numbered from what is already there, not from 1. A repo re-running this after a real pivot
// must not overwrite the ADR that explains the thing it is pivoting away from.
const existing = readdirSync('.sdlc/memory/decisions')
  .map((f) => Number(f.match(/^ADR-(\d+)/)?.[1]))
  .filter(Number.isInteger);
let n = existing.length ? Math.max(...existing) + 1 : 1;

// The product, technical, UI and research documents.
//
// These used to exist only as keys inside project-brief.json — one machine artifact nobody
// opens. An engineer joining in month three reads `docs/`, and a PRD that lives only in a JSON
// field is a PRD that was never written. Generated, so the brief stays the source of truth and
// the files cannot drift from it.
// The brief itself, committed.
//
// Every document below says "generated from project-brief.json — edit the brief, not this
// file", which was a lie: the brief existed only on the runner and went away with it. So the
// generated files could never be regenerated, and when a bug meant they were written and not
// staged, the eight minutes of planning behind them could not be recovered either — the whole
// stage had to run again.
//
// An artifact that cannot be read after the run that made it is an artifact nobody can correct.
writeFileSync('.sdlc/memory/project-brief.json', `${JSON.stringify(brief, null, 2)}\n`);
// And the numbering the brief's coverage refers to: spec-coverage reads both, long after this run.
writeFileSync('.sdlc/memory/spec-index.json', `${JSON.stringify(specIndex, null, 2)}\n`);

mkdirSync('docs', { recursive: true });
const docs = [];
for (const [file, body] of [
  ['docs/prd.md', renderPrd(brief)],
  ['docs/trd.md', renderTrd(brief)],
  ['docs/ui.md', renderUi(brief)],
  ['docs/research.md', renderResearch(brief)],
]) {
  if (!body) continue;
  writeFileSync(file, `${body.replace(/\n{3,}/g, '\n\n').trimEnd()}\n`);
  docs.push(file);
}
// Listed where every agent looks first. Written and linked from nowhere, these reached no
// planner, implementer, reviewer or QA run — each ticket re-invented the PRD it was part of.
const indexPath = '.sdlc/memory/index.md';
writeFileSync(indexPath, indexWithDocs(existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : null, docs));

const adrs = [];
for (const d of brief.decisions ?? []) {
  const file = `.sdlc/memory/decisions/ADR-${String(n).padStart(4, '0')}-${
    d.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)}.md`;
  writeFileSync(file, renderAdr(d, { number: n, issue, date: today }));
  adrs.push(file);
  n++;
}

// --- the four verbs ----------------------------------------------------------
// Written here rather than left to whichever issue lands first. The old arrangement was a
// note in an epic body — "whichever piece first has something real to verify should fill
// these in" — which is an expectation, not a step, and an expectation with no owner is a
// thing that does not happen.
const verbs = [];
{
  // Created when it is not there. `.sdlc/config.yml` on a greenfield repo calls these verbs
  // through npm — that indirection is what lets the planner decide the commands without
  // anyone editing a config file afterwards, and it only works if the file exists. A Python
  // project gets a package.json holding `"sdlc:verify": "pytest"`, which is odd to look at
  // and is one indirection rather than two places that have to agree.
  if (!existsSync('package.json')) {
    const name = (process.env.GITHUB_REPOSITORY ?? 'app').split('/').pop();
    writeFileSync('package.json', `${JSON.stringify({ name, private: true, scripts: {} }, null, 2)}\n`);
    process.stdout.write('created package.json — the pipeline calls the sdlc: verbs through npm\n');
  }
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  pkg.scripts ??= {};
  // Overwritten, and shown old beside new. A verb that already existed was skipped with a
  // warning nobody read, and this branch is the one place a verb may change at all (the guard
  // refuses it on every ticket's), so a pivot through `/sdlc replan-project` could not change
  // one anywhere. This PR always waits for a person, and the list below is what they read.
  for (const [verb, cmd] of Object.entries({
    'sdlc:verify': brief.commands.verify,
    'sdlc:serve': brief.commands.serve,
    'sdlc:seed': brief.commands.seed,
    'sdlc:ready': brief.commands.ready,
  })) {
    if (!cmd) continue;
    const was = pkg.scripts[verb];
    pkg.scripts[verb] = cmd;
    verbs.push(was && was !== cmd ? `\`${verb}\`: \`${was}\` → \`${cmd}\`` : `\`${verb}\`: \`${cmd}\``);
  }
  writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
}

// --- the PR ------------------------------------------------------------------
await run('git', ['config', 'user.name', 'github-actions[bot]']);
await run('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
await run('git', ['checkout', '-B', branch]);
// `docs` too. The renderers write the PRD, TRD, UI and research documents and nothing staged
// them, so the first brief that produced all four opened a pull request with none of them —
// the files existed on the runner and were thrown away with it.
await run('git', ['add', '.sdlc/memory', 'package.json', 'docs']);

const changed = await run('git', ['status', '--porcelain', '--', '.sdlc/memory', 'package.json']);
if (!changed) die('the brief produced no change to commit — nothing to approve');

await run('git', ['commit', '-m',
  `chore: record the project's architecture before the first ticket\n\n` +
  `${brief.stack.choice}\n\nDecided for #${issue}. Every agent reads .sdlc/memory/project.md ` +
  `before planning, so this is the file that steers every ticket after it.`]);
await run('git', ['push', '-u', 'origin', branch, '--force']);

// --- the checks the merge button waits for ------------------------------------
// With verify.mode own, setup and doctor require ci-verify on the base branch. This PR is opened
// with GITHUB_TOKEN, which starts no workflow, and ci-verify skips sdlc/project-* heads anyway
// (sdlc:verify is red on a brief by construction). So the required check said "Expected" for
// ever, and the one human merge on the whole project needed an admin bypass — which a ruleset
// with no bypass actor never allows. It is passed here, on exactly the commit just pushed, and
// loudly: a brief nobody can merge is a stall, not a warning.
//
// REQUIRED_CHECKS is lib/checks.js expectedChecks, one per line, worked out by the step before
// this one. Handed in, because this script reads no config at all: its gate is unconditional.
const required = String(process.env.REQUIRED_CHECKS ?? '').split('\n').map((c) => c.trim()).filter(Boolean);
if (required.includes('ci-verify')) {
  await gh(['api', '-X', 'POST', `repos/${repoOf()}/statuses/${await run('git', ['rev-parse', 'HEAD'])}`,
    '-f', 'state=success', '-f', 'context=ci-verify', '-f', 'description=architecture brief: no code to verify']);
}
// The repository's own required checks are its own to run, and nothing starts them on a PR the
// pipeline opened; the person merging is told where, rather than finding a grey button.
const theirs = required.filter((c) => c !== 'ci-verify');

// What the owner does next, said the same way in both places. Both said "merge, THEN comment
// `/sdlc approve`" — and the merge already continues the route (on-merge hands off), so an owner
// who did as told dispatched the next stage twice: the one human touch on the whole project,
// and following its instructions exactly was what went wrong.
const whatNext = (what) => `**Merge ${what} — that is the approval; nothing else to type.** ` +
  `\`/sdlc answer "…"\` on #${issue} re-runs the architecture with your answer; ` +
  '`/sdlc replan-project "…"` redoes it.';

const body = [
  `## Project brief for #${issue}`,
  '',
  brief.product,
  '',
  `**Stack.** ${brief.stack.choice}`,
  '',
  brief.stack.why,
  '',
  '### Invariants',
  ...(brief.invariants ?? []).map((i) => `- ${i}`),
  '',
  '### Modules',
  ...(brief.architecture.modules ?? []).map((m) => `- \`${m.path}\` — ${m.holds}`),
  '',
  '### Decisions recorded',
  ...adrs.map((f) => `- \`${f}\``),
  ...(docs.length ? ['', '**Documents**', ...docs.map((f) => `- \`${f}\``)] : []),
  verbs.length ? `\n### package.json\n${verbs.map((v) => `- ${v}`).join('\n')}` : '',
  brief.commands.stubbed?.length
    ? `\n**Stubbed on purpose:** ${brief.commands.stubbed.join('; ')}`
    : '',
  brief.open_questions?.length
    ? `\n### Open questions\n${brief.open_questions.map((q) => `- ${q}`).join('\n')}\n\nThese are for you. They could not be decided from the brief.`
    : '',
  '',
  `**Deploy.** ${brief.deploy}`,
  '',
  '---',
  '',
  `Confidence ${brief.confidence ?? '(none)'}. **This gate is not a config flag.** Every other ` +
  'gate in this framework can be switched off; this one cannot, because architecture is the ' +
  'most expensive decision here to reverse — a wrong stack is discovered on ticket nine, ' +
  'after eight implementations, reviews and QA cycles have assumed it. You read this once ' +
  'per repository.',
  '',
  whatNext('this PR'),
  theirs.length
    ? `\n**Required checks.** ${theirs.map((c) => `\`${c}\``).join(', ')} ${theirs.length === 1 ? 'is' : 'are'} this ` +
      'repository\'s own, and a pull request the pipeline opens starts no workflow: approve ' +
      `${theirs.length === 1 ? 'its run' : 'their runs'} in the Actions tab before merging. ` +
      '`ci-verify` has nothing to verify on a brief, and is marked passed.'
    : '',
  '',
  `Closes nothing — #${issue} continues once this merges.`,
].filter((l) => l !== '').join('\n');

const url = await gh(['pr', 'create', '--head', branch, '--title',
  `Project brief: ${brief.stack.choice.slice(0, 60)}`, '--body', body])
  .catch(async (e) => {
    // Already open from a previous run: update it rather than failing the stage. Which PR that
    // is goes by identity, never by branch name alone — `--head` lists a fork's sdlc/project-<n>
    // too, and the first result was edited and announced as the brief the owner should merge.
    // The one the ledger recorded, while it is open; else this repository's, opened by the pipeline.
    const { ledger } = await readLedger(repoOf(), issue);
    const recorded = ledger?.brief_pr
      && (await ghJson(['pr', 'view', String(ledger.brief_pr), '--json', 'state']).catch(() => ({}))).state === 'OPEN';
    const open = recorded ? ledger.brief_pr
      : (await ghJson(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,isCrossRepository,author']).catch(() => []))
        .find((p) => p.isCrossRepository === false && isPipelineAuthor(p.author?.login))?.number;
    if (!open) die(`could not open the project brief PR: ${String(e.stderr || e.message).split('\n')[0]}`);
    await gh(['pr', 'edit', String(open), '--body', body]);
    return String(open);
  });

const pr = String(url).trim().split('/').pop();
setOutput('pr', pr);

// --- the gate ----------------------------------------------------------------
await gh(['issue', 'comment', String(issue), '--body',
  `## The architecture is decided, and a person has to read it\n\n` +
  `#${pr} records it: the stack, the module shape, the invariants every later ticket has to ` +
  `respect, and the four \`sdlc:\` verbs the pipeline calls.\n\n` +
  '**This is the one gate that is not a config flag.** Nothing is planned on this repo until ' +
  'you merge it, whatever `gates.plan_approval` says, because this is the decision that is ' +
  'most expensive to reverse and you only read it once.\n\n' +
  whatNext(`#${pr}`)]).catch(() => {});

// The brief PR, by number: what the merge and a command recognise as this issue's brief, rather
// than whatever a listing by branch name returns (a fork can open an sdlc/project-<n> of its own).
//
// And a rejected brief kept for the rerun has been answered by this one. Left on the ledger, the
// next `/sdlc replan-project` would hand the planner the brief the owner read AND one it had
// already corrected, and tell it to fix the old one.
await updateLedger(repoOf(), Number(issue), (l) => {
  if (!l) return null;
  const { 'project-brief': _answered, ...rest } = l.rejected_artifacts ?? {};
  return { ...l, brief_pr: Number(pr), ...(l.rejected_artifacts ? { rejected_artifacts: rest } : {}) };
});

await markResume(repoOf(), issue, 'project', 'after');
await advance(issue, 'needs-human', { agent: 'project-planner' });

process.stdout.write(`issue #${issue}: project brief on PR #${pr}, waiting for a human\n`);
