#!/usr/bin/env node
// Resolves, for one issue: which agent plans it, and how much deliberation it gets.
// Emitted as step outputs so the workflow's conditions stay readable.
import { ghJson, setOutput, loadConfig, repo as repoOf } from './lib/actions.js';
import { writeFileSync } from 'node:fs';
import { agentForIssue, councilFor } from './lib/routing.js';
import { readLedger } from './lib/state-io.js';

const issue = process.env.ISSUE;
const cfg = await loadConfig();
const data = await ghJson(['issue', 'view', issue, '--json', 'labels,title']);

const agent = agentForIssue({ labels: data.labels }, cfg);

// A plan already approved is not replanned. It is posted.
//
// Everything between here and the post — validation, the gate, the reviewer — has already
// run and said yes. Re-running the stage from the top to repair a step after that point
// discards the expensive half of the work to retry the cheap half, which is how one failed
// `gh` call cost a second three-agent council.
const { ledger: pre } = await readLedger(repoOf(), Number(issue)).catch(() => ({ ledger: null }));
if (pre?.approved_work_order) {
  writeFileSync('work-order.json', JSON.stringify(pre.approved_work_order, null, 2));
  setOutput('agent', agent);
  setOutput('mode', 'resume');
  setOutput('pack', '');
  process.stdout.write(
    `#${issue}: a plan for this issue was already approved (v${pre.approved_work_order.version ?? '?'}) ` +
    'and never posted — posting it rather than planning again\n');
  process.exit(0);
}

// The Router may ask for LESS deliberation on a ticket that does not need it — a council is
// for plans that are expensive to get wrong, and a wording change is not one. It may only
// ask downward: turning a single pass into a council costs three times as much on a ticket a
// cheap model classified, which is the wrong direction for a cheap model to be able to push.
const { ledger } = await readLedger(repoOf(), Number(issue)).catch(() => ({ ledger: null }));
const asked = ledger?.flow_plan?.councils?.plan;
const configured = councilFor('plan', cfg).length > 1 ? 'council' : 'single';
const mode = asked === 'single' ? 'single' : configured;
if (asked && asked !== configured) {
  process.stdout.write(
    `the route asked for a ${asked} plan and config says ${configured} — using ${mode}` +
    `${asked === 'council' ? ' (a route may reduce deliberation, never add cost)' : ''}\n`);
}
const stages = mode === 'council' ? councilFor('plan', { ...cfg, councils: { ...cfg.councils, plan: 'council' } }) : [{ role: 'plan' }];

// A bug is diagnosed by reproducing it, not by debating a plan for it — the debugger owns
// the investigation, and a council of three static readers adds cost without adding evidence.
const effectiveMode = agent === 'debugger' ? 'single' : mode;
void stages;

setOutput('agent', agent);
setOutput('mode', effectiveMode);
setOutput('pack', agent === 'debugger' ? 'debugger.md' : 'planner.md');
process.stdout.write(`#${issue} "${data.title}" -> ${agent} (${effectiveMode})\n`);
