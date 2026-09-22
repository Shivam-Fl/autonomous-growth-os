#!/usr/bin/env node
// Decides who must look at a finished work order before code is written.
import { readFileSync } from 'node:fs';
import { setOutput, loadConfig, gh, repo as repoOf } from './lib/actions.js';
import { planGate } from './lib/routing.js';
import { effectiveGates } from './lib/route.js';
import { readLedger } from './lib/state-io.js';

const cfg = await loadConfig();
const wo = JSON.parse(readFileSync('work-order.json', 'utf8'));

// A gate the ROUTE asked for counts too — additively. The Router may look at a ticket and
// decide a person should read the plan even though config does not require it; what it can
// never do is the reverse, and effectiveGates is where that asymmetry is enforced rather
// than remembered.
const { ledger } = await readLedger(repoOf(), Number(wo.issue)).catch(() => ({ ledger: null }));
const gates = effectiveGates(cfg.gates ?? {}, ledger?.flow_plan?.gates ?? {});
const { gate, reason } = planGate(wo, { ...cfg, gates });

// How many times this plan has already been sent back. The reviewer needs it, because the
// right bar is not the same on round one and round four.
//
// Three rejections on one issue, each naming entirely different defects, each of them real —
// and the fourth plan was approved after the budget had spent seven of its ten attempts. The
// reviewer was not wrong any of those times; it was answering "is every detail pinned?", a
// question that always has another answer, while the implementer's own contract already makes
// it responsible for the details a plan does not spell out.
const rejections = await gh(['issue', 'view', String(wo.issue), '--json', 'comments',
  '--jq', '[.comments[] | select(.body | startswith("## Plan review: rejected") or ' +
          'startswith("## Plan review: could not verify"))] | length'])
  .then((n) => Number(n.trim()) || 0)
  .catch(() => 0);
setOutput('rejections', String(rejections));

setOutput('gate', gate);
setOutput('reason', reason);
setOutput('confidence', String(wo.confidence ?? ''));

if (gate === 'human' && reason !== 'gates.plan_approval is on') {
  // Say WHY a human is being pulled in when the gates were configured off — otherwise it
  // looks like the config was ignored.
  await gh(['issue', 'comment', String(wo.issue), '--body',
    `Routing this to a human despite the gate settings: **${reason}**.\n\n` +
    'Comment `/sdlc approve` to proceed anyway, or `/sdlc reject` with what to change.']);
}
process.stdout.write(`gate=${gate} (${reason})\n`);
