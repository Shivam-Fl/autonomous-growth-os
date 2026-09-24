#!/usr/bin/env node
// Prints the work order this issue is being built from, to stdout.
//
// It used to print the newest issue comment whose first ```json block had `files` and
// `acceptance` — from anyone. On a public repo that is an outsider's plan, and with no outsider
// at all it was the rejected plan quoted inside "Plan review: rejected", or a /sdlc status dump.
// The implementer is told to apply this file EXACTLY. So it comes from the ledger, which only
// the pipeline writes (readWorkOrder falls back to pipeline-authored comments for issues planned
// before the ledger held it), and nothing is printed rather than a guess.
import { loadConfig, die, repo } from './lib/actions.js';
import { readWorkOrder } from './lib/work-order.js';

const issue = process.env.ISSUE ?? die('ISSUE is not set');
const wo = await readWorkOrder(repo(), issue, await loadConfig());
if (!wo) die(`no work order recorded for issue #${issue} — the pipeline has not posted one it would build`);
process.stdout.write(JSON.stringify(wo, null, 2) + '\n');
