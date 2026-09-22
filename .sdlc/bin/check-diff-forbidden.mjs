#!/usr/bin/env node
// What the branch ACTUALLY changed, against the paths a human reserved.
//
// `check-forbidden.mjs` reads the work order — which is written by the agent whose output is
// being constrained. An implementer can declare three innocent files, edit `.github/workflows`
// with its shell, and pass a check that only ever looked at the declaration. The reserved
// paths include the workflows, the schemas, the validators and the kill switch: exactly the
// machinery that would have caught it.
//
// A prompt is not an authorization boundary and neither is a self-reported file list. This
// asks git.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findForbidden } from './lib/guards.js';
import { loadConfig, setOutput, die } from './lib/actions.js';
const exec = promisify(execFile);

const cfg = await loadConfig();
const pr = process.env.PR;

// Two callers, two sources, both authoritative in their own context.
//
// Before the PR exists the implementer has the branch on disk, so ask git. Once it exists,
// ask GitHub for the PR's own file list: that is the diff a reviewer and a merge will see,
// and it cannot be affected by anything left in a runner's working tree.
let changed;
if (pr) {
  const { stdout } = await exec('gh', ['pr', 'diff', pr, '--name-only'], { maxBuffer: 8 << 20 });
  changed = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
} else {
  const base = process.env.BASE_BRANCH || die('BASE_BRANCH is required when PR is not set');
  const head = process.env.HEAD_REF || 'HEAD';
  // --diff-filter is deliberately absent: a DELETED workflow is as much a rewrite of the rules
  // as an edited one. -z because a path may contain anything, including a newline.
  const { stdout } = await exec('git', ['diff', '--name-only', '-z', `${base}...${head}`], { maxBuffer: 8 << 20 });
  changed = stdout.split('\0').filter(Boolean);
}

// Renames are reported as their new path by --name-only, and a symlink is a path like any
// other: what matters is the path recorded in the tree, which is what git just printed.
const hits = findForbidden(changed, cfg.forbidden_paths ?? []);

setOutput('changed', String(changed.length));
setOutput('violations', String(hits.length));

if (hits.length) {
  die(`this branch changes ${hits.length} reserved path(s):\n` +
      hits.map((h) => `  ${h.path}  (matched ${h.rule})`).join('\n') +
      '\n\nThese are reserved because they are the machinery that constrains the pipeline — ' +
      'workflows, schemas, validators, the kill switch. The work order did not have to declare ' +
      'them for this to be caught: the diff is the authority, not the plan.\n' +
      'A human must review and land this change deliberately.');
}
process.stdout.write(`no reserved paths touched (${changed.length} file(s) changed)\n`);
