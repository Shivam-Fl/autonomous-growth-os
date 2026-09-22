#!/usr/bin/env node
// The revised work order's version, set by a script rather than asked for in a prompt.
//
// `version` is load-bearing: `already-implemented.mjs` compares it against what the branch
// already implements, and that comparison is the only thing that makes attempt N+1 rebuild
// instead of re-opening the PR it just rejected. A work order that forgot to increment is
// therefore not a cosmetic slip — it silently turns a rework into a no-op.
//
// So it is not an instruction. The previous version comes off the issue, the new one is that
// plus one, and the agent's own number is overwritten whatever it said.

import { readFileSync, writeFileSync } from 'node:fs';
import { ghJson, extractJsonBlock, setOutput, die } from './lib/actions.js';

const issue = process.env.ISSUE ?? die('ISSUE is required');
const file = process.env.FILE ?? 'work-order.json';

const wo = JSON.parse(readFileSync(file, 'utf8'));

const data = await ghJson(['issue', 'view', issue, '--json', 'comments']);
let previous = 0;
for (const c of data.comments ?? []) {
  const posted = extractJsonBlock(c.body);
  if (posted?.files && posted?.acceptance) previous = Math.max(previous, Number(posted.version) || 1);
}
if (!previous) die(`issue #${issue} has no posted work order to revise`);

const next = previous + 1;
if (wo.version !== next) process.stdout.write(`agent wrote version ${wo.version ?? '(none)'} — correcting to ${next}\n`);
wo.version = next;
writeFileSync(file, `${JSON.stringify(wo, null, 2)}\n`);

setOutput('version', String(next));
setOutput('previous', String(previous));
process.stdout.write(`work order v${previous} -> v${next}\n`);
