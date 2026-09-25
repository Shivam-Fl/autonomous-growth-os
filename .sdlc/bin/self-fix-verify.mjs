#!/usr/bin/env node
// Proves a self-fix, in a job that can write nothing.
//
// The fixer's patch is applied to a fresh checkout of the framework at the version this
// repository runs, then held to three things: lib/self-fix.js's bound (what it touches, no rule,
// schemas only wider), its regression test FAILING with the fix taken back out — a test that
// passes either way proves nothing about the defect — and the framework's whole suite passing
// with it in.
//
// This runs the agent's tests, which is running the agent's code: that is why it is a job of its
// own with a read-only token and nothing after it. What it writes is a report the land job reads
// alongside its own re-check of the bound, never instead of it.
//
//   FRAMEWORK_DIR  the framework checkout (default framework)
//   PATCH          the fixer's patch (default self-fix/self-fix.patch)
//   OUT            the report (default self-fix-verify.json)
import { execFile } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setOutput } from './lib/actions.js';
import { checkFix, classOf, readFix } from './lib/self-fix.js';

const exec = promisify(execFile);
const fw = resolve(process.env.FRAMEWORK_DIR ?? 'framework');
const patch = resolve(process.env.PATCH ?? 'self-fix/self-fix.patch');
const out = process.env.OUT ?? 'self-fix-verify.json';

const tail = (s) => String(s ?? '').split('\n').slice(-40).join('\n');
// stdin closed: a test that spawns something reading it would otherwise wait on a pipe forever.
// NODE_TEST_CONTEXT dropped: set by an enclosing `node --test`, it makes a nested one report to
// that parent and exit 0 whatever its tests did — every run would read as green.
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const run = (cmd, args, timeout) => {
  const p = exec(cmd, args, { cwd: fw, env, timeout, maxBuffer: 64 * 1024 * 1024 });
  p.child.stdin?.end();
  return p.then((r) => ({ code: 0, output: r.stdout + r.stderr }))
    .catch((e) => ({ code: e.code ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}${e.killed ? '\n[timed out]' : ''}` }));
};

const report = { ok: false, problems: [], tests: [], fails_without_fix: null, suite_passes: null };
const done = () => {
  report.ok = !report.problems.length && report.fails_without_fix === true && report.suite_passes === true;
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  setOutput('ok', String(report.ok));
  process.stdout.write(report.ok ? 'the fix is inside the bound, its test proves it, and the suite passes\n'
    : `the fix is not proven:\n${report.problems.map((p) => `  - ${p}`).join('\n')}\n`);
};

const applied = await run('git', ['apply', '--index', '--whitespace=nowarn', patch], 60_000);
if (applied.code !== 0) {
  report.problems.push(`the patch does not apply to the framework at the version this repository runs: ${tail(applied.output)}`);
  done();
  process.exit(0);
}

const files = await readFix(fw);
report.problems.push(...checkFix(files));
report.tests = files.filter((f) => classOf(f.path) === 'regression test' && f.status !== 'D').map((f) => f.path);

if (report.tests.length) {
  // The fix taken back out, the tests kept: they must fail. Written from what readFix already
  // holds rather than a stash, so there is no second git state to get wrong.
  const code = files.filter((f) => classOf(f.path) !== 'regression test');
  for (const f of code) {
    if (f.status === 'A') rmSync(join(fw, f.path), { force: true });
    else writeFileSync(join(fw, f.path), f.before);
  }
  const without = await run('node', ['--test', ...report.tests], 10 * 60_000);
  report.fails_without_fix = without.code !== 0;
  if (!report.fails_without_fix) report.problems.push(`its tests (${report.tests.join(', ')}) pass without the fix, so they prove nothing about the defect`);
  for (const f of code) if (f.status !== 'D') writeFileSync(join(fw, f.path), f.after);

  const suite = await run('npm', ['test'], 30 * 60_000);
  report.suite_passes = suite.code === 0;
  if (!report.suite_passes) report.problems.push(`the framework's suite fails with the fix in:\n${tail(suite.output)}`);
}
done();
