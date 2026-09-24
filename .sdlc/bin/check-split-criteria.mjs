#!/usr/bin/env node
// Refuses a work order that neither answers nor defers a criterion the split gave this issue —
// in the plan gate, BEFORE the plan is kept on the ledger.
//
// This ran only in post-work-order, after the gate had stashed the plan as validated and the
// reviewer as approved. It died there before anything cleared either stash, so every retry the
// failure path started restored the same plan (plan-strategy's `resume` or `review`), re-posted
// it and died on the same line; only a person's `/sdlc reject` got out. Here the plan is refused
// as the validator refuses one: kept as rejected_artifacts["work-order"], which plan-strategy
// hands the next planner as previous-output.json, and any stash of it is dropped — a resumed or
// re-reviewed plan reaches this step too, and left stashed it would be restored again.
import { readFileSync } from 'node:fs';
import { ghJson, die, repo as repoOf } from './lib/actions.js';
import { updateLedger } from './lib/state-io.js';
import { rememberRejected } from './lib/artifact.js';
import { unansweredSplitCriteria } from './lib/issue-body.js';

const issue = process.env.ISSUE;
const raw = readFileSync('work-order.json', 'utf8');
const issueBody = await ghJson(['issue', 'view', issue, '--json', 'body']).then((d) => d.body ?? '');
const { ids, message } = unansweredSplitCriteria(JSON.parse(raw), issueBody);
if (!ids.length) {
  process.stdout.write(`issue #${issue}: every split criterion is answered or deferred\n`);
  process.exit(0);
}

await updateLedger(repoOf(), Number(issue), (l) => {
  if (!l || !(l.approved_work_order || l.validated_work_order)) return null;
  const next = { ...l };
  delete next.approved_work_order;
  delete next.validated_work_order;
  return next;
}).catch((e) => process.stdout.write(`::warning::could not drop the refused plan's stash: ${e.message}\n`));
await rememberRejected(repoOf(), issue, 'work-order', raw, [message]);
die(message);
