#!/usr/bin/env node
// Maps a workflow_run completion back to its PR.
import { readFileSync } from 'node:fs';
import { setOutput, die } from './lib/actions.js';

const ev = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
const pr = ev.workflow_run?.pull_requests?.[0]?.number;
if (!pr) die('workflow_run carried no pull request');
setOutput('pr', String(pr));
setOutput('sha', ev.workflow_run.head_sha ?? '');
