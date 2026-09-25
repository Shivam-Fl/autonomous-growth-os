#!/usr/bin/env node
// Run, on what an agent has just written, every check the job will run on it after the agent —
// the list in lib/gate-checks.js — and say what would be refused, so it is fixed in the same
// session rather than found by a failed run.
//
//   node .sdlc/bin/preflight.mjs [--issue N]      checks every gated artifact present here
//
// Nothing is written: the job's own run, from a checkout the agent never touched, is the gate.
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { GATES } from './lib/gate-checks.js';
import { loadArtifact } from './lib/artifact.js';
import { checkQaConsistency } from './lib/qa-consistency.js';
import { flags } from './lib/actions.js';

const exec = promisify(execFile);
const { issue } = flags();
const env = { ...process.env, PREFLIGHT: '1', ...(issue && issue !== true ? { ISSUE: String(issue) } : {}) };
delete env.KEEP_REJECTED;
// Not the agent step's outputs: a check run from inside it would set them.
delete env.GITHUB_OUTPUT;

const present = Object.entries(GATES).filter(([, g]) => existsSync(g.file));
if (!present.length) {
  process.stdout.write('preflight: none of the files this pipeline checks is here: ' +
    `${Object.values(GATES).map((g) => g.file).join(', ')}. Write yours where your instructions say, then run this again.\n`);
  process.exit(1);
}

let total = 0;
for (const [name, gate] of present) {
  const problems = [];
  const art = loadArtifact(name, gate.file);
  if (!art.ok) problems.push(...art.errors);
  else if (name === 'qa-report') problems.push(...(checkQaConsistency(art.data).errors ?? []));
  if (art.ok) {
    for (const [script, ...args] of gate.then ?? []) {
      await exec('node', [join('.sdlc', 'bin', script), ...args], { env, maxBuffer: 16 << 20 }).catch((e) => {
        const said = `${e.stderr ?? ''}${e.stdout ?? ''}`.split('\n').map((l) => l.replace(/^sdlc: /, '').trim())
          .filter((l) => l && !/^::(warning|notice)/.test(l));
        problems.push(`${script}: ${said.join(' | ') || e.message}`);
      });
    }
  }
  total += problems.length;
  process.stdout.write(problems.length
    ? `✗ ${gate.file} would be refused:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`
    : `✓ ${gate.file}${art.repairs.length ? ` (the job will repair: ${art.repairs.join('; ')})` : ''}\n`);
}
process.stdout.write(total ? `preflight: ${total} problem(s). Fix them and run this again.\n` : 'preflight: clean\n');
process.exit(total ? 1 : 0);
