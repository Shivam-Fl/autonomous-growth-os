#!/usr/bin/env node
// Start our own CI if nothing is gating this PR yet.
//
// The pipeline pushes as github-actions[bot], and GitHub holds bot-triggered `pull_request`
// runs at `action_required` until a human approves them. A held run produces no check, so the
// PR has no CI at all — and the gate, reading an empty rollup, cannot tell that apart from a
// repo that simply has no CI configured. It proceeded, and a PR reached review and QA with
// nothing verified.
//
// Waiting for a human is not a fix: it turns every rework into a manual step. So the gate
// starts the run itself. Dispatch is the one trigger GitHub does not hold.

import { ghJson, setOutput, loadConfig } from './lib/actions.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

const pr = process.env.PR;
const cfg = await loadConfig();
const mode = cfg.verify?.mode ?? 'own';

const done = (why) => { process.stdout.write(`${why}\n`); setOutput('dispatched', 'false'); process.exit(0); };

// `existing` means the repo's own CI gates the PR; `none` means nothing does. Neither is ours
// to start.
if (mode === 'existing' || mode === 'none') done(`verify.mode is "${mode}" — not ours to start`);

const { statusCheckRollup = [] } = await ghJson(['pr', 'view', pr, '--json', 'statusCheckRollup']);
const ours = statusCheckRollup.filter((c) => /ci-verify/i.test(c.name ?? c.context ?? ''));
if (ours.length) done(`ci-verify is already reporting on this PR (${ours[0].conclusion ?? ours[0].state ?? 'pending'})`);

await exec('node', ['.sdlc/bin/dispatch.mjs', 'ci-verify.yml', '-f', `pr=${pr}`]);
setOutput('dispatched', 'true');
process.stdout.write(`no ci-verify on PR #${pr} — dispatched it, since a bot-triggered run would be held for approval\n`);
