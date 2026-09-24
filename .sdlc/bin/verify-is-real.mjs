#!/usr/bin/env node
// Fails when the branch has code and the script CI runs to verify it is still a stub.
//
// On a repository with no code the architecture brief writes every sdlc: verb as a stub, because
// a real `pytest` or `docker compose up` fails on its first call with nothing to run. That is
// right until there is code — and from then on a stub `sdlc:verify` passes every PR by definition,
// which is the one thing CI must never do. So the first branch with code must make it real (the
// reserved-path guard allows filling a stub exactly once), and this says so in the CI log, where
// the self-heal loop reads it, with the target the brief recorded.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadConfig } from './lib/actions.js';
import { gatingScripts, isTrivialScript } from './lib/guards.js';
import { hasProductCode } from './lib/project.js';

const cfg = await loadConfig();
const scripts = existsSync('package.json') ? (JSON.parse(readFileSync('package.json', 'utf8')).scripts ?? {}) : {};
const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n');
if (!hasProductCode(files)) { process.stdout.write('no product code yet — a stub verify is expected\n'); process.exit(0); }

const unit = String(cfg.verify?.unit ?? '');
const stubs = gatingScripts({ unit }, scripts).filter((n) => typeof scripts[n] === 'string' && isTrivialScript(scripts[n]));
if (!stubs.length) process.exit(0);
const md = existsSync('.sdlc/memory/project.md') ? readFileSync('.sdlc/memory/project.md', 'utf8') : '';
const targets = stubs.map((n) => md.match(new RegExp(`\`${n}\` — stub now; target (\`[^\\n]+\`)`))?.[1]).filter(Boolean);
process.stdout.write(`::error::${stubs.join(', ')} ${stubs.length === 1 ? 'is' : 'are'} still a stub, and this branch has code — ` +
  'CI would pass it without running anything. Make it the real command in package.json' +
  (targets.length ? ` (the architecture brief's target: ${targets.join(', ')})` : '') +
  ', installing its own toolchain on a clean runner, with at least one test for the code this branch adds.\n');
process.exit(1);
