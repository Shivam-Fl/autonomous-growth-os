// Shared helpers for the workflow scripts: gh calls, step outputs, config loading.
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = process.env.SDLC_ROOT ?? process.cwd();

/**
 * Run `gh`. A flag whose value is a DOCUMENT is delivered on stdin, never in argv.
 *
 * `execve(2)` fails with E2BIG when the argument block is too large: Linux caps a single
 * argv entry at MAX_ARG_STRLEN — 32 pages, 131072 bytes — and the whole args+env block at a
 * quarter of RLIMIT_STACK. argv is an operating-system channel sized for flags.
 *
 * Every body this pipeline posts is built from model output: a work order, a review, a diff,
 * a failure packet. None of them has an upper bound, so putting one in argv makes the kernel
 * limit a load-bearing assumption about how much an agent writes. It held until a council's
 * eighth revision of one work order crossed 128 KiB; the plan reviewer had already APPROVED
 * that plan, the post threw E2BIG, and the self-heal loop — seeing a failed plan stage —
 * spent a second three-agent council to replace a plan that was never wrong.
 *
 * A size threshold with a fallback would have kept the same channel and guessed at the same
 * ceiling. stdin has no such limit, gh takes `--body-file -` for exactly this, and one path
 * for every body means there is no size at which behaviour changes.
 *
 * spawn rather than promisify(execFile), deliberately: execFile has no `input` option (that
 * is execFileSync), so passing one is silently ignored and a command reading stdin — `gh api
 * --input -` — hangs forever instead of failing.
 */
const DOCUMENT_FLAGS = new Map([
  ['--body', '--body-file'],
  ['-b', '--body-file'],
  ['--notes', '--notes-file'],
]);

function viaStdin(args, input) {
  const i = args.findIndex((a, n) => DOCUMENT_FLAGS.has(a) && n < args.length - 1);
  if (i === -1) return { args, input };
  // stdin is one channel. Two documents in one call would silently deliver one of them.
  if (input !== undefined) throw new Error(`gh: ${args[i]} and an explicit stdin in one call`);
  const rest = args.slice(i + 2);
  if (rest.some((a) => DOCUMENT_FLAGS.has(a))) throw new Error('gh: two document flags in one call');
  return {
    args: [...args.slice(0, i), DOCUMENT_FLAGS.get(args[i]), '-', ...rest],
    input: args[i + 1],
  };
}

export function gh(argv, { input: stdin, ...opts } = {}) {
  const { args, input } = viaStdin(argv, stdin);
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'], ...opts });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve(stdout.trim());
      const err = new Error(`gh ${args[0]} failed (${code}): ${stderr.trim()}`);
      err.stderr = stderr;
      err.code = code;
      reject(err);
    });
    child.stdin.on('error', () => { /* the child exited before reading the body */ });
    child.stdin.end(input ?? '');
  });
}

export async function ghJson(args) {
  return JSON.parse(await gh(args));
}

export function setOutput(key, value) {
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  if (process.env.GITHUB_OUTPUT) {
    const delim = 'EOF_' + Math.random().toString(36).slice(2);
    appendFileSync(process.env.GITHUB_OUTPUT, key + '<<' + delim + '\n' + v + '\n' + delim + '\n');
  }
  process.stdout.write(key + '=' + v + '\n');
}

/**
 * js-yaml is imported LAZILY. Some scripts run before `npm ci` — ci-verify reads
 * `verify.install` from config to decide how to install in the first place — so a top-level
 * dependency import here is a bootstrap deadlock: the config that says how to install
 * cannot be read until after installing.
 */
export async function loadConfig(root = ROOT) {
  const path = join(root, '.sdlc', 'config.yml');
  if (!existsSync(path)) die('no .sdlc/config.yml — run `sdlc init` first');
  const { load: parseYaml } = await import('js-yaml');
  return parseYaml(readFileSync(path, 'utf8')) ?? {};
}

/**
 * Where a dying script leaves the reason, for the handler that answers it.
 *
 * The `if: failure()` step that dispatches the self-heal loop runs in the SAME job as the
 * step that failed, while that job is still in progress — and GitHub serves neither run logs
 * nor job logs for a run that has not finished. The first live test of the loop produced
 * exactly that: "no log, no digest and no failing-check detail could be retrieved", on a job
 * whose own console plainly said what broke. The error has to be handed over locally,
 * because the API cannot hand it back.
 */
export const ERROR_LOG = process.env.SDLC_ERROR_LOG
  ?? join(process.env.RUNNER_TEMP || tmpdir(), 'sdlc-error.log');

/**
 * Leave the reason for a non-zero exit where the failure handler will find it.
 *
 * Separate from `die()` because not every failure is a die(): a refused lock, a budget
 * exceeded, a report that fails its own consistency check — all of them printed a perfectly
 * clear message and then called `process.exit(1)` directly. The breadcrumb covered `die()`
 * and nothing else, so those produced "no log, no digest and no failing-check detail could
 * be retrieved" and went to a human. A plan stage refused a lock because another run already
 * held it, which is correct behaviour, and it was reported as an unreadable mystery.
 *
 * Appended, not written: one step can fail after another already left a note, and both are
 * evidence. Failure here is never fatal — off a runner the path may not be writable, and a
 * breadcrumb that cannot be dropped must not turn a real error into a different one.
 */
export function noteError(message) {
  try { appendFileSync(ERROR_LOG, 'sdlc: ' + String(message).trim() + '\n'); }
  catch { /* not on a runner, or read-only */ }
}

// An uncaught throw is a failure too, and the self-heal loop can only act on what it can
// read.
//
// `spawn E2BIG` killed a step after the plan had been APPROVED. The error went to stderr and
// nowhere else, because only `die()` writes the breadcrumb — so the fixer saw `unknown` with
// the step's name as its entire evidence, could not tell a posting failure from a crashed
// planner, and re-ran the whole council to repair a `gh` call. A classifier reading the real
// message would have had somewhere to start.
//
// Registered here because every runner script imports this module. Exit 1 afterwards, since
// swallowing an uncaught error would turn a broken step into a green one.
for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.on(event, (err) => {
    const message = err instanceof Error ? (err.code ? err.code + ': ' + err.message : err.message)
                                         : String(err);
    process.stderr.write('sdlc: ' + event + ': ' + message + '\n');
    if (err instanceof Error && err.stack) process.stderr.write(err.stack + '\n');
    noteError(message);
    process.exit(1);
  });
}

export function die(message, code = 1) {
  process.stderr.write('sdlc: ' + message + '\n');
  noteError(message);
  process.exit(code);
}

export function flags(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

export const repo = () => process.env.GITHUB_REPOSITORY ?? die('GITHUB_REPOSITORY is not set');

/** Extract the first fenced json block from a markdown body. */
export function extractJsonBlock(body) {
  const m = String(body ?? '').match(/```json\s*\n([\s\S]*?)\n```/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}
