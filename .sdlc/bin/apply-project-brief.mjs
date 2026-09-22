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
import { gh, setOutput, die, repo as repoOf } from './lib/actions.js';
import { advance } from './lib/advance.js';
import { renderProjectMd, renderAdr } from './lib/project.js';
import { markResume } from './lib/route-io.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const run = (cmd, args) => exec(cmd, args).then((r) => r.stdout.trim());

const issue = process.env.ISSUE ?? die('ISSUE is required');
const brief = JSON.parse(readFileSync('project-brief.json', 'utf8'));
const branch = `sdlc/project-${issue}`;
const today = new Date().toISOString().slice(0, 10);

// --- the files ---------------------------------------------------------------
mkdirSync('.sdlc/memory/decisions', { recursive: true });
writeFileSync('.sdlc/memory/project.md', renderProjectMd(brief));

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
  for (const [verb, cmd] of Object.entries({
    'sdlc:verify': brief.commands.verify,
    'sdlc:serve': brief.commands.serve,
    'sdlc:seed': brief.commands.seed,
    'sdlc:ready': brief.commands.ready,
  })) {
    if (!cmd) continue;
    if (pkg.scripts[verb] && pkg.scripts[verb] !== cmd) {
      process.stdout.write(`::warning::${verb} already exists as "${pkg.scripts[verb]}" — not overwritten\n`);
      continue;
    }
    pkg.scripts[verb] = cmd;
    verbs.push(`${verb} → \`${cmd}\``);
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
  `Merge this PR, then comment \`/sdlc approve\` on #${issue} to start the work.`,
  `\`/sdlc replan-project "<why>"\` runs it again with your note instead.`,
  '',
  `Closes nothing — #${issue} continues once this is approved.`,
].filter((l) => l !== '').join('\n');

const url = await gh(['pr', 'create', '--head', branch, '--title',
  `Project brief: ${brief.stack.choice.slice(0, 60)}`, '--body', body])
  .catch(async (e) => {
    // Already open from a previous run: update it rather than failing the stage.
    const open = await gh(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number', '--jq', '.[0].number']).catch(() => '');
    if (!open) die(`could not open the project brief PR: ${String(e.stderr || e.message).split('\n')[0]}`);
    await gh(['pr', 'edit', open, '--body', body]);
    return open;
  });

const pr = String(url).trim().split('/').pop();
setOutput('pr', pr);

// --- the gate ----------------------------------------------------------------
await gh(['issue', 'comment', String(issue), '--body',
  `## The architecture is decided, and a person has to read it\n\n` +
  `#${pr} records it: the stack, the module shape, the invariants every later ticket has to ` +
  `respect, and the four \`sdlc:\` verbs the pipeline calls.\n\n` +
  '**This is the one gate that is not a config flag.** Nothing is planned on this repo until ' +
  'you approve it, whatever `gates.plan_approval` says, because this is the decision that is ' +
  'most expensive to reverse and you only read it once.\n\n' +
  `Merge #${pr} and comment \`/sdlc approve\` to continue, or ` +
  '`/sdlc replan-project "<why>"` to have it decided again.']).catch(() => {});

await markResume(repoOf(), issue, 'project', 'after');
await advance(issue, 'needs-human', { agent: 'project-planner' });

process.stdout.write(`issue #${issue}: project brief on PR #${pr}, waiting for a human\n`);
