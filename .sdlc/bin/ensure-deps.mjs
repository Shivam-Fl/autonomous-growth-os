#!/usr/bin/env node
// Makes the framework's one dependency available in ANY repo, including ones with no
// package.json at all.
//
// The scripts are Node (every GitHub runner has Node), but a Go or Python repo has nothing
// for `npm ci` to install, and running it there fails the job before the pipeline starts.
// So: install js-yaml only if it is actually missing, without touching the repo's manifest.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

try {
  await import('js-yaml');
  process.stdout.write('js-yaml already present\n');
} catch {
  process.stdout.write('installing js-yaml (--no-save, the repo manifest is left alone)\n');
  await exec('npm', ['install', '--no-save', '--no-audit', '--no-fund', 'js-yaml'], {
    maxBuffer: 10 * 1024 * 1024,
  });
  process.stdout.write('js-yaml installed\n');
}
