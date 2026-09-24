#!/usr/bin/env node
// The revised work order's version, set by a script rather than asked for in a prompt.
//
// `version` is load-bearing: `already-implemented.mjs` compares it against what the branch
// already implements, and that comparison is the only thing that makes attempt N+1 rebuild
// instead of re-opening the PR it just rejected. A work order that forgot to increment is
// therefore not a cosmetic slip — it silently turns a rework into a no-op.
//
// So it is not an instruction. It is counted from the ledger's record of the work order, the
// same way post-work-order counts it when it posts, and the agent's own number is overwritten
// whatever it said. It used to be the highest version in any comment on the issue, so a number
// anyone typed into a JSON block became the pipeline's.

import { readFileSync, writeFileSync } from 'node:fs';
import { setOutput, die, repo as repoOf } from './lib/actions.js';
import { readLedger } from './lib/state-io.js';
import { nextWorkOrderVersion } from './lib/work-order.js';

const issue = process.env.ISSUE ?? die('ISSUE is required');
const file = process.env.FILE ?? 'work-order.json';

const wo = JSON.parse(readFileSync(file, 'utf8'));
const { ledger } = await readLedger(repoOf(), Number(issue));

// Past whatever the branch implements too, exactly as post-work-order numbers it.
const next = Math.max(nextWorkOrderVersion(ledger), (ledger?.implemented_version ?? 0) + 1);
if (wo.version !== next) process.stdout.write(`agent wrote version ${wo.version ?? '(none)'} — correcting to ${next}\n`);
wo.version = next;
writeFileSync(file, `${JSON.stringify(wo, null, 2)}\n`);

setOutput('version', String(next));
