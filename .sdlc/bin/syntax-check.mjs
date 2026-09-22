#!/usr/bin/env node
// An honest typecheck for a plain-JS repo: parse every source file and fail on a syntax
// error. It is not type inference, and it does not pretend to be — but it is real, it is
// free, and it catches the mistake an agent actually makes (a broken edit) before a model
// is ever asked to look at the diff.
import { readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'test-results', 'playwright-report']);
const files = [];

(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (['.js', '.mjs', '.cjs'].includes(extname(entry))) files.push(full);
  }
})(process.cwd());

let failed = 0;
for (const f of files) {
  try {
    await exec('node', ['--check', f]);
  } catch (e) {
    failed++;
    process.stdout.write((e.stderr ?? e.message).split('\n').slice(0, 4).join('\n') + '\n');
  }
}
process.stdout.write(`\nsyntax-check: ${files.length - failed}/${files.length} files parsed\n`);
process.exit(failed ? 1 : 0);
