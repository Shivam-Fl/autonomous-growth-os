#!/usr/bin/env node
// Phase one of the Router: decide the route with a script, for free, when a rule is sure.
//
// Phase two is a cheap model and it runs in the workflow only when this says it cannot
// decide. That ordering is the whole design — the Router runs on EVERY issue, so a model
// call here is a tax on the whole backlog, and most tickets are one of a handful of shapes a
// regex recognises perfectly well.
//
// Writes flow-plan.json and `decided=true` when a rule fires, `decided=false` otherwise.
// Never guesses: "I do not know" is a real answer here and the model pass is what it costs.

import { existsSync, writeFileSync } from 'node:fs';
import { ghJson, setOutput, loadConfig, die } from './lib/actions.js';
import { fastPath, namedPaths, FULL } from './lib/route.js';

const issue = process.env.ISSUE ?? die('ISSUE is required');
const cfg = await loadConfig();
const routing = cfg.route ?? {};

const raw = await ghJson(['issue', 'view', issue, '--json', 'number,title,body,labels']);
const labels = (raw.labels ?? []).map((l) => String(l.name ?? l).toLowerCase());
const isEpic = labels.includes('sdlc:epic') || labels.includes('epic');

const commit = (plan) => {
  writeFileSync('flow-plan.json', `${JSON.stringify(plan, null, 2)}\n`);
  setOutput('decided', 'true');
  setOutput('matched_rule', plan.matched_rule ?? '');
  setOutput('route', plan.route.join(','));
  process.stdout.write(
    `matched by script: ${plan.matched_rule}\n` +
    `  kind       ${plan.kind}\n` +
    `  route      ${plan.route.join(' -> ') || '(none)'}\n` +
    `  on finish  ${plan.on_complete}\n` +
    `  confidence ${plan.confidence}\n`);
  process.exit(0);
};

// An epic is not a routing question, it is a question of who owns the ticket, and the answer
// has never depended on config. It is also the one hand-off that was quietly broken: intake's
// "is this an epic?" branch read a step output nothing ever set, so every epic was dispatched
// to the planner — which refuses epics — and only ran at all because the label happened to
// trigger the maintainer separately.
if (isEpic) {
  commit({
    issue: Number(raw.number),
    kind: 'epic',
    reasoning: 'Labelled an epic, which means it is too large for one work order. It goes to the maintainer to be split, and each piece is routed on its own.',
    route: ['maintainer'],
    on_complete: 'comment-only',
    risk: 0,
    confidence: 95,
    matched_rule: 'label:epic',
  });
}

if (routing.enabled === false) {
  commit({
    issue: Number(raw.number),
    kind: 'feature',
    reasoning: 'Routing is switched off in config, so this gets the chain the framework shipped with. Recorded as a setting, not as a decision about this ticket.',
    route: [...FULL],
    on_complete: 'merge',
    risk: 0,
    confidence: 100,
    matched_rule: 'routing-disabled',
  });
}

// A human asked for this to be re-routed, which means a rule already answered and was wrong.
// Running the same regexes over the same text produces the same answer, so the fast path is
// skipped and the note goes to the model.
if (String(process.env.REPLAN ?? '') === 'true') {
  setOutput('decided', 'false');
  process.stdout.write('re-routing at a maintainer\'s request — skipping the rules that already answered.\n');
  process.exit(0);
}

if (routing.fast_path === false) {
  setOutput('decided', 'false');
  process.stdout.write('route.fast_path is off — every issue goes to the model pass.\n');
  process.exit(0);
}

// A path the issue names is only a fact if it is really there. Checked against the working
// tree, not asserted from the text — an issue naming `src/checkout.ts` on a repo that has no
// such file is describing something from memory, and a route built on it would send the
// implementer to edit a file that does not exist.
const named = namedPaths(raw.body ?? '');
const existingPaths = named.filter((p) => existsSync(p));
if (named.length && named.length !== existingPaths.length) {
  process.stdout.write(
    `issue names ${named.length} path(s), ${existingPaths.length} of which exist: ` +
    `${named.map((p) => `${p}${existsSync(p) ? '' : ' (missing)'}`).join(', ')}\n`);
}

const plan = fastPath(raw, { existingPaths });
if (plan) commit(plan);

setOutput('decided', 'false');
process.stdout.write(
  'no deterministic rule matched this issue with any confidence.\n' +
  'Handing it to the model pass rather than defaulting to the full chain — a cheap phase ' +
  'that quietly routes everything the same way is not a cheap phase, it is a comment.\n');
