// What the pipeline may change about itself, decided by a script and never by a model.
//
// A framework defect used to stop for a person every time, including the ones that were plainly
// plumbing: a length cap an agent's honest output ran into, a script that crashed on a missing
// directory, a workflow that passed a value without its newline. Those are bugs, and waiting for
// a person to paste the fix triage already wrote cost hours each. So a bounded stage fixes them
// — but only them. This file is the bound.
//
// The line is RULES. Every gate, trust check, permission, allowlist and validator is a rule, and
// an agent that could loosen one to make its own failure go away leaves nothing auditable behind.
// The prompts are off-limits too: they are how the agents are told the rules. What is left is
// plumbing, and a fix to plumbing is held to: a class of file it may touch, no line it changes
// that mentions a rule, a schema that only accepts more than it did, a regression test that fails
// without the fix, the whole suite green with it, and the project maintainer's consent.
//
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// ponytail: the sensitive-line check is a keyword list, not an understanding of the code. A rule
// written without any of these words passes it — which is what the maintainer's consult is for.
// It fails closed: a fix it refuses goes to a person, exactly as every framework defect did before.

/** Paths a self-fix may change, in the framework's own layout. */
export const CLASSES = [
  { name: 'script plumbing', re: /^\.sdlc\/bin\/.+\.(mjs|js)$/ },
  { name: 'output schema (widening only)', re: /^\.sdlc\/schemas\/[^/]+\.json$/ },
  { name: 'workflow wiring', re: /^\.github\/workflows\/[^/]+\.yml$/ },
  { name: 'the CLI', re: /^bin\/sdlc$/ },
  { name: 'regression test', re: /^tests\/.+\.(mjs|js)$/ },
];

/**
 * Files that ARE rules, or are the machinery bounding this one. Plumbing lives beside them in
 * the same directories, so they are named one by one.
 */
export const RULES = [
  // the gates and what they read
  '.sdlc/bin/plan-gate.mjs', '.sdlc/bin/gate-outcome.mjs', '.sdlc/bin/merge-pr.mjs',
  '.sdlc/bin/check-diff-forbidden.mjs', '.sdlc/bin/check-forbidden.mjs', '.sdlc/bin/check-evidence.mjs',
  '.sdlc/bin/check-split-criteria.mjs', '.sdlc/bin/check-url.mjs', '.sdlc/bin/verify-token.mjs',
  '.sdlc/bin/verify-is-real.mjs', '.sdlc/bin/verify-memory-pr.mjs', '.sdlc/bin/lib/checks.js',
  // who is trusted, and what an agent may run
  '.sdlc/bin/lib/guards.js', '.sdlc/bin/lib/issue-body.js', '.sdlc/bin/maintainer-inputs.mjs',
  '.sdlc/bin/qa-credentials.mjs', '.sdlc/bin/claude-args.mjs', '.sdlc/bin/sdlc-ctl.mjs',
  // what an artifact is checked against
  '.sdlc/bin/lib/validate.js', '.sdlc/bin/lib/artifact.js', '.sdlc/bin/lib/qa-consistency.js',
  // this bound, and the stage it bounds
  '.sdlc/bin/lib/self-fix.js', '.sdlc/bin/self-fix-verify.mjs', '.sdlc/bin/self-fix-land.mjs',
  '.sdlc/bin/self-fix-digest.mjs', '.github/workflows/sdlc-self-fix.yml',
];

/**
 * A changed line naming any of these touches a rule, wherever it sits. Checked on every added
 * and removed line outside the tests, so a fix cannot move a rule by rewriting around it.
 */
export const SENSITIVE = [
  /trust/i, /allowlist/i, /forbidden/i, /halted/i, /tamper/i, /kill.?switch/i, /SDLC_ENABLED/,
  /permissions\s*:/, /secrets\./, /persist-credentials/, /id-token/, /github_token/i, /GH_TOKEN/,
  /\b(plan|merge)_approval\b/, /\bgates\b/, /\bapprove/i, /reserved/i, /allowedTools|allowed_tools|--allowed/,
  /\bvalidate\(|loadArtifact|formatErrors/, /author_association|authorAssociation|association/, /\bOWNER\b|\bMEMBER\b|collaborator/i,
  /isPipelineAuthor|pipelineOnly/,
];

// In a workflow, a new action is a new supplier with the job's token.
const WORKFLOW_SENSITIVE = [/^\s*-?\s*uses\s*:/];

/** Which class a path falls in, or null. */
export const classOf = (path) => CLASSES.find((c) => c.re.test(path))?.name ?? null;

/**
 * May the file triage named be fixed here at all? Checked before anything is spent: a defect in
 * a prompt or a rule goes straight to a person.
 */
export function fixable(file) {
  const f = String(file ?? '').replace(/^\.\//, '').replace(/:\d+(:\d+)?$/, '');
  if (!f) return { ok: false, why: 'triage named no file' };
  if (RULES.includes(f)) return { ok: false, why: `\`${f}\` is a rule, which no agent may change` };
  if (/^\.sdlc\/agents\//.test(f)) return { ok: false, why: `\`${f}\` is a prompt, which no agent may change` };
  const cls = classOf(f);
  if (!cls || cls === 'regression test') return { ok: false, why: `\`${f}\` is not plumbing a self-fix may change` };
  return { ok: true, class: cls };
}

/**
 * Everything wrong with a proposed fix, as sentences; empty means it is inside the bound.
 * `files`: [{ path, status: 'A'|'M'|'D'|'R', before, after, added: [lines], removed: [lines], mode }].
 */
export function checkFix(files) {
  const problems = [];
  if (!files.length) return ['the fix changes nothing'];
  if (!files.some((f) => classOf(f.path) === 'regression test' && f.status !== 'D')) {
    problems.push('the fix adds no regression test under tests/ — a fix nothing proves is a guess');
  }
  if (!files.some((f) => classOf(f.path) && classOf(f.path) !== 'regression test')) {
    problems.push('the fix changes only tests');
  }
  for (const f of files) {
    const cls = classOf(f.path);
    if (f.binary) problems.push(`\`${f.path}\` is a binary change`);
    if (f.mode && !/^100(644|755)$/.test(f.mode)) problems.push(`\`${f.path}\` changes to mode ${f.mode} (a symlink or submodule)`);
    if (RULES.includes(f.path)) { problems.push(`\`${f.path}\` is a rule, which no agent may change`); continue; }
    if (!cls) { problems.push(`\`${f.path}\` is outside what a self-fix may change`); continue; }
    if (cls === 'regression test') continue;
    if (f.status === 'D' || f.status === 'R') { problems.push(`\`${f.path}\` is ${f.status === 'D' ? 'deleted' : 'renamed'} — a fix edits plumbing, it does not remove it`); continue; }
    const extra = cls === 'workflow wiring' ? WORKFLOW_SENSITIVE : [];
    for (const line of [...f.added, ...f.removed, ...(f.context ?? [])]) {
      const hit = [...SENSITIVE, ...extra].find((re) => re.test(line));
      if (hit) { problems.push(`\`${f.path}\` changes a line that touches a rule (${hit}): \`${line.trim().slice(0, 120)}\``); break; }
    }
    if (cls === 'output schema (widening only)') {
      let b, a;
      try { b = f.status === 'A' ? null : JSON.parse(f.before); a = JSON.parse(f.after); } catch (e) {
        problems.push(`\`${f.path}\` is not valid JSON after the fix: ${e.message}`); continue;
      }
      if (!b) { problems.push(`\`${f.path}\` is a new schema — a fix widens an existing one`); continue; }
      problems.push(...schemaNarrowings(b, a).map((w) => `\`${f.path}\` ${w}`));
    }
  }
  return problems;
}

const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
const types = (t) => (t === undefined ? null : new Set([].concat(t)));
const NOTES = new Set(['description', 'title', '$comment', 'examples', 'default']);
const UPPER = ['maxLength', 'maxItems', 'maximum', 'exclusiveMaximum', 'maxProperties'];
const LOWER = ['minLength', 'minItems', 'minimum', 'exclusiveMinimum', 'minProperties'];
const DROP_ONLY = ['pattern', 'format', 'const', 'not', 'uniqueItems', 'multipleOf'];

/**
 * How `after` accepts LESS than `before` — each a sentence; empty when every document `before`
 * accepted, `after` accepts too. Conservative: a change it cannot prove widens is a narrowing.
 */
export function schemaNarrowings(before, after, at = '$') {
  if (typeof before !== 'object' || before === null || typeof after !== 'object' || after === null) {
    if (after === true || same(after, {})) return [];
    return same(before, after) ? [] : [`changes ${at} in a way that is not provably wider`];
  }
  const out = [];
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = before[k], a = after[k];
    if (NOTES.has(k) || same(b, a)) continue;
    const where = `${at}.${k}`;
    if (UPPER.includes(k)) { if (a !== undefined && (b === undefined || a < b)) out.push(`lowers or adds ${where}`); continue; }
    if (LOWER.includes(k)) { if (a !== undefined && (b === undefined || a > b)) out.push(`raises or adds ${where}`); continue; }
    if (DROP_ONLY.includes(k)) { if (a !== undefined) out.push(`adds or changes ${where}`); continue; }
    if (k === 'enum') { if (a !== undefined && (b === undefined || !b.every((v) => a.some((x) => same(x, v))))) out.push(`drops a value from ${where}`); continue; }
    if (k === 'required') { if ((a ?? []).some((r) => !(b ?? []).includes(r))) out.push(`requires more at ${where}`); continue; }
    if (k === 'type') { const bt = types(b), at2 = types(a); if (at2 && (!bt || [...bt].some((t) => !at2.has(t) && !(t === 'integer' && at2.has('number'))))) out.push(`narrows ${where}`); continue; }
    if (k === 'additionalProperties') {
      if (a === undefined || a === true) continue;
      if (b === false) continue;                       // was closed: anything is wider
      if (b === undefined || b === true) { out.push(`closes ${where}`); continue; }
      out.push(...(a === false ? [`closes ${where}`] : schemaNarrowings(b, a, where)));
      continue;
    }
    if (k === 'properties') {
      const bp = b ?? {}, ap = a ?? {};
      for (const p of new Set([...Object.keys(bp), ...Object.keys(ap)])) {
        if (!(p in ap)) { if (after.additionalProperties === false) out.push(`removes ${where}.${p} from a closed object`); continue; }
        if (!(p in bp)) { if (before.additionalProperties !== false && !same(ap[p], {}) && ap[p] !== true) out.push(`constrains the previously free ${where}.${p}`); continue; }
        out.push(...schemaNarrowings(bp[p], ap[p], `${where}.${p}`));
      }
      continue;
    }
    if (k === 'items') { out.push(...(a === undefined ? [] : b === undefined ? [`adds ${where}`] : schemaNarrowings(b, a, where))); continue; }
    out.push(`changes ${where}, which is not provably wider`);
  }
  return out;
}

/** runtime.self_fix with its defaults. On unless switched off; three fixes a day. */
export function selfFixConfig(cfg = {}) {
  const s = cfg.self_fix ?? {};
  return {
    enabled: s.enabled !== false,
    perDay: Number.isFinite(Number(s.per_day)) ? Number(s.per_day) : 3,
    frameworkRepo: s.framework_repo ?? null,
  };
}

/** Parse `git diff --cached -U0 --binary` output into per-file added/removed lines. */
export function diffLines(diff) {
  const files = new Map();
  let cur = null;
  for (const line of String(diff).split('\n')) {
    const head = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (head) { cur = { path: head[2], added: [], removed: [], binary: false, mode: null, hunk: false, context: [] }; files.set(cur.path, cur); continue; }
    if (!cur) continue;
    const mode = /^(?:new file|new|old) mode (\d+)$/.exec(line);
    if (mode) { cur.mode = mode[1]; continue; }
    if (/^GIT binary patch|^Binary files /.test(line)) { cur.binary = true; continue; }
    // Only inside a hunk: before the first @@ a `--- a/x` is the header, and inside one a
    // removed line that itself starts with `--` looks exactly like it.
    // The hunk header ends with the line git takes for the enclosing function: a change inside
    // `isTrustedAuthor` touches trust even when the changed line never says so.
    if (line.startsWith('@@')) { cur.hunk = true; const fn = /^@@[^@]*@@\s?(.*)$/.exec(line)?.[1]; if (fn) cur.context.push(fn); continue; }
    if (!cur.hunk) continue;
    if (line.startsWith('+')) cur.added.push(line.slice(1));
    else if (line.startsWith('-')) cur.removed.push(line.slice(1));
  }
  return files;
}

/**
 * The staged change in a git checkout, as checkFix reads it. The patch is applied with
 * `git apply --index` first, so HEAD is the before and the index the after.
 */
export async function readFix(dir) {
  const git = (args) => exec('git', ['-C', dir, ...args], { maxBuffer: 64 * 1024 * 1024 }).then((r) => r.stdout);
  const lines = diffLines(await git(['diff', '--cached', '-U0', '--binary', '--no-renames']));
  const status = new Map((await git(['diff', '--cached', '--name-status', '--no-renames'])).split('\n').filter(Boolean)
    .map((l) => { const [s, p] = l.split('\t'); return [p, s[0]]; }));
  const show = (spec) => git(['show', spec]).catch(() => '');
  return Promise.all([...status].map(async ([path, s]) => ({
    path, status: s,
    before: s === 'A' ? '' : await show(`HEAD:${path}`),
    after: s === 'D' ? '' : await show(`:${path}`),
    ...(lines.get(path) ?? { added: [], removed: [], context: [], binary: false, mode: null }),
  })));
}
