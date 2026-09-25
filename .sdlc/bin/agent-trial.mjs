#!/usr/bin/env node
// A real piece of work per model, graded against tests it never sees.
//
// agent-check proves Claude Code can RUN on a model: stream, call a tool, stop. It says nothing
// about whether the model can do an implementer's job, and "it answered" is how an unknown model
// ends up writing a project's code. This hands each model a small repository with a spec, three
// defects across three files and a function to write — worded like a work order — and then runs
// a hidden suite over what it left. The work is kept, so a person can read the code too.
//
// Two tasks. `ledger`: four small functions against a spec, 16 hidden tests, a few minutes' work.
// `adtrack` (trials/adtrack.json): an HTTP service — validation, idempotent ingest under concurrent
// requests, atomic storage, UTC date ranges, last-touch attribution, refunds — with the defects
// spread through eight files and 33 hidden tests; closer to one of the pipeline's real tickets.
//
//   MODELS=a,b TRIAL_TASK=ledger|adtrack node .sdlc/bin/agent-trial.mjs <out.json> <work-dir>
//   (claude on PATH, ANTHROPIC_* set)
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const exec = promisify(execFile);

export const FILES = {
  'package.json': JSON.stringify({ name: 'ledger', type: 'module', private: true, scripts: { test: 'node --test' } }, null, 2),
  'SPEC.md': `# Ledger settlement

Amounts are integer minor units (paise, cents) everywhere. Never floats.

## parseCsv(text) -> rows  (src/parse.js)

- The first line is the header: \`id,account,amount,currency\`.
- A field may be wrapped in double quotes; a quoted field may contain commas, and \`""\` inside
  it is one literal quote.
- Lines end in \\n or \\r\\n. Blank lines are ignored wherever they are.
- \`amount\` is a decimal string with at most two fraction digits (\`12\`, \`12.5\`, \`12.50\`,
  \`-3.07\`), converted to integer minor units EXACTLY (\`12.5\` -> 1250, \`0.29\` -> 29).
  Anything else — three fraction digits, exponents, letters, empty — throws an Error whose
  \`code\` is \`'BAD_AMOUNT'\`.

## settle(rows, { currency }) -> { balances, duplicates }  (src/ledger.js)

- Rows with the same \`id\` are one entry: the first is kept, and every later one is counted in
  \`duplicates\`.
- Every kept row's \`currency\` must equal \`currency\`, or it throws an Error whose \`code\` is
  \`'CURRENCY_MISMATCH'\` and whose message names the row's id.
- \`balances\` is \`[{ account, minor }]\`, the sum per account, sorted by \`minor\` descending,
  then \`account\` ascending. An account whose sum is 0 is left out.

## formatMinor(minor, currency) -> string  (src/format.js)

- \`INR 1,234.50\`: the code, a space, thousands separators, always two decimals.
- Negative amounts: \`-INR 12.00\`.
`,
  'src/money.js': `// Money is integer minor units everywhere. See SPEC.md.
export function toMinor(amount) {
  return Math.floor(parseFloat(amount) * 100);
}
`,
  'src/parse.js': `import { toMinor } from './money.js';

export function parseCsv(text) {
  const [header, ...lines] = text.trim().split('\\n');
  const cols = header.split(',');
  return lines.map((line) => {
    const cells = line.split(',');
    const row = Object.fromEntries(cols.map((c, i) => [c, cells[i]]));
    return { ...row, amount: toMinor(row.amount) };
  });
}
`,
  'src/ledger.js': `export function settle(rows, { currency } = {}) {
  const sums = {};
  for (const r of rows) sums[r.account] = (sums[r.account] ?? 0) + r.amount;
  return { balances: Object.entries(sums).map(([account, minor]) => ({ account, minor })), duplicates: 0 };
}
`,
  'src/format.js': `export function formatMinor(minor, currency) {
  throw new Error('not implemented');
}
`,
  'test/visible.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/parse.js';
import { settle } from '../src/ledger.js';
import { formatMinor } from '../src/format.js';

test('parses a simple file', () => {
  assert.deepEqual(parseCsv('id,account,amount,currency\\na1,rent,12.50,INR\\n'),
    [{ id: 'a1', account: 'rent', amount: 1250, currency: 'INR' }]);
});
test('settles per account, largest first', () => {
  const rows = parseCsv('id,account,amount,currency\\na1,rent,10,INR\\na2,rent,5,INR\\na3,food,20,INR\\n');
  assert.deepEqual(settle(rows, { currency: 'INR' }).balances, [{ account: 'food', minor: 2000 }, { account: 'rent', minor: 1500 }]);
});
test('formats minor units', () => {
  assert.equal(formatMinor(123450, 'INR'), 'INR 1,234.50');
});
`,
};

// Never in the repository while the model works.
const HIDDEN = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/parse.js';
import { settle } from '../src/ledger.js';
import { formatMinor } from '../src/format.js';

const H = 'id,account,amount,currency\\n';
const one = (amount) => parseCsv(H + 'a1,x,' + amount + ',INR\\n')[0].amount;
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return 'no error'; };
const rows = (...r) => r.map(([id, account, amount, currency = 'INR']) => ({ id, account, amount, currency }));

test('amount: 0.29 is exactly 29', () => assert.equal(one('0.29'), 29));
test('amount: -3.07 is exactly -307', () => assert.equal(one('-3.07'), -307));
test('amount: 12, 12.5 and 12.50', () => assert.deepEqual([one('12'), one('12.5'), one('12.50')], [1200, 1250, 1250]));
test('amount: three fraction digits is BAD_AMOUNT', () => assert.equal(code(() => one('12.345')), 'BAD_AMOUNT'));
test('amount: letters, exponent and empty are BAD_AMOUNT', () => {
  assert.deepEqual([code(() => one('abc')), code(() => one('1e3')), code(() => one(''))], ['BAD_AMOUNT', 'BAD_AMOUNT', 'BAD_AMOUNT']);
});
test('csv: a quoted field keeps its comma', () => assert.equal(parseCsv(H + 'a1,"rent, office",10,INR\\n')[0].account, 'rent, office'));
test('csv: "" inside quotes is one quote', () => assert.equal(parseCsv(H + 'a1,"the ""big"" one",10,INR\\n')[0].account, 'the "big" one'));
test('csv: blank lines anywhere, and CRLF', () => {
  const r = parseCsv('id,account,amount,currency\\r\\n\\r\\na1,x,1,INR\\r\\n\\r\\na2,y,2,INR\\r\\n\\r\\n');
  assert.deepEqual(r.map((x) => [x.id, x.amount, x.currency]), [['a1', 100, 'INR'], ['a2', 200, 'INR']]);
});
test('settle: the first of a duplicated id is kept, the rest counted', () => {
  const s = settle(rows(['a1', 'x', 500], ['a1', 'x', 900], ['a1', 'x', 700], ['a2', 'y', 100]), { currency: 'INR' });
  assert.deepEqual(s, { balances: [{ account: 'x', minor: 500 }, { account: 'y', minor: 100 }], duplicates: 2 });
});
test('settle: another currency is CURRENCY_MISMATCH, naming the id', () => {
  let err;
  try { settle(rows(['a1', 'x', 1], ['b7', 'x', 1, 'USD']), { currency: 'INR' }); } catch (e) { err = e; }
  assert.equal(err?.code, 'CURRENCY_MISMATCH');
  assert.match(String(err?.message), /b7/);
});
test('settle: minor descending, then account ascending, negatives last', () => {
  const s = settle(rows(['1', 'b', 300], ['2', 'a', 300], ['3', 'c', -50], ['4', 'd', 900]), { currency: 'INR' });
  assert.deepEqual(s.balances.map((b) => b.account), ['d', 'a', 'b', 'c']);
});
test('settle: an account that sums to zero is left out', () => {
  const s = settle(rows(['1', 'a', 300], ['2', 'a', -300], ['3', 'b', 1]), { currency: 'INR' });
  assert.deepEqual(s.balances, [{ account: 'b', minor: 1 }]);
});
test('format: negative', () => assert.equal(formatMinor(-1200, 'INR'), '-INR 12.00'));
test('format: under one unit', () => assert.equal(formatMinor(5, 'INR'), 'INR 0.05'));
test('format: millions', () => assert.equal(formatMinor(100000000, 'USD'), 'USD 1,000,000.00'));
test('format: zero', () => assert.equal(formatMinor(0, 'INR'), 'INR 0.00'));
`;

export const TASK = `You are implementing a work order in this repository.

Work order: make the ledger match SPEC.md exactly.

- Read SPEC.md first. The code under src/ has defects against it, and one function is not
  implemented at all.
- Fix every defect at its cause and implement what is missing. Money stays in integer minor
  units: no floating-point arithmetic on amounts.
- test/visible.test.js must pass. Do not change its expectations.
- Add your own tests under test/ for each rule in SPEC.md, including the edge cases it names.
- Run \`npm test\` and finish only when it passes. Then reply with a short summary of what you
  changed and why.`;

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const noCtx = () => { const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; return env; };

/** node --test over `files` in `cwd`: pass/fail counts and the failing test names. */
async function runTests(cwd, files) {
  // Per test too: a server that never answers would otherwise hold the whole suite.
  const r = await exec('node', ['--test', '--test-reporter=tap', '--test-timeout=15000', ...files], { cwd, env: noCtx(), timeout: 300_000, maxBuffer: 16 << 20 })
    .then((x) => x.stdout).catch((e) => `${e.stdout ?? ''}`);
  const n = (k) => Number(new RegExp(`^# ${k} (\\d+)`, 'm').exec(r)?.[1] ?? 0);
  const failed = [...r.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1]).filter((t) => !/\.test\.js$/.test(t));
  return { pass: n('pass'), total: n('tests'), failed };
}

const code = (dir, f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
const adtrack = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'trials/adtrack.json'), 'utf8'));

/** What each task hands over, what it hides, and the signals read from the code it gets back. */
export const TASKS = {
  ledger: {
    files: FILES, hidden: HIDDEN, task: TASK, timeoutMs: 25 * 60_000,
    // Secondary: the hidden suite already checks exactness (0.29 -> 29). Integer arithmetic on the
    // parsed parts is fine; parsing the decimal as a float is the defect. Read without comments:
    // a model that writes "no parseFloat here" is not using it.
    signals: (dir) => ({ float_free: !/parseFloat|Math\.(round|floor|ceil)\([^)]*\* ?100|toFixed/.test(code(dir, 'src/money.js')) }),
  },
  adtrack: {
    files: adtrack.files, hidden: adtrack.hidden, task: adtrack.task, timeoutMs: adtrack.timeout_minutes * 60_000,
    signals: (dir) => {
      const src = existsSync(join(dir, 'src')) ? readdirSync(join(dir, 'src')).map((f) => code(dir, join('src', f))).join('\n') : '';
      let pkg = {};
      try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); } catch { /* none left */ }
      return {
        atomic_write: /\brename(Sync)?\(/.test(src),
        float_free: !/parseFloat|toFixed/.test(src),
        no_dependencies: !Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length,
      };
    },
  },
};

export async function trial(model, { task: name = 'ledger', claude = 'claude', timeoutMs, keep } = {}) {
  const task = TASKS[name];
  if (!task) throw new Error(`no trial task "${name}" — one of ${Object.keys(TASKS).join(', ')}`);
  const dir = mkdtempSync(join(tmpdir(), 'agent-trial-'));
  for (const [f, body] of Object.entries(task.files)) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), body); }
  const visibleSha = sha(join(dir, 'test/visible.test.js'));
  const t0 = Date.now();
  let res = {};
  let error = null;
  try {
    const p = exec(claude, ['-p', task.task, '--model', model, '--allowedTools', 'Bash,Read,Edit,Write,Grep,Glob',
      '--output-format', 'json'], { cwd: dir, timeout: timeoutMs ?? task.timeoutMs, maxBuffer: 64 << 20 });
    p.child.stdin?.end();
    const { stdout } = await p;
    try { res = JSON.parse(stdout); } catch { /* judged by the work alone */ }
    if (res.is_error) error = String(res.result ?? '').slice(0, 300);
  } catch (e) {
    error = String(e.stderr || e.message).replace(/\s+/g, ' ').slice(0, 400);
  }
  const secs = Math.round((Date.now() - t0) / 1000);
  const own = readdirSync(join(dir, 'test')).filter((f) => f.endsWith('.test.js') && f !== 'visible.test.js');
  const visibleUntouched = existsSync(join(dir, 'test/visible.test.js')) && sha(join(dir, 'test/visible.test.js')) === visibleSha;
  const visible = await runTests(dir, [join(dir, 'test/visible.test.js')]);
  const theirs = await runTests(dir, own.map((f) => join(dir, 'test', f)));
  mkdirSync(join(dir, '.hidden'));
  writeFileSync(join(dir, '.hidden/hidden.test.js'), task.hidden);
  const hidden = await runTests(dir, [join(dir, '.hidden/hidden.test.js')]);
  if (keep) cpSync(dir, join(keep, `${name}-${model.replace(/[^\w.-]/g, '_')}`), { recursive: true, filter: (p) => !p.includes('node_modules') });
  const signals = task.signals(dir);
  return {
    model, task: name, secs, turns: res.num_turns ?? null, error,
    hidden, visible, visible_untouched: visibleUntouched,
    own_tests: { files: own, ...theirs },
    signals, float_free: signals.float_free,
    reply: String(res.result ?? '').slice(0, 1500),
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const models = String(process.env.MODELS ?? '').split(',').map((m) => m.trim()).filter(Boolean);
  const keep = process.argv[3] || 'trial-work';
  mkdirSync(keep, { recursive: true });
  const results = [];
  const task = process.env.TRIAL_TASK || 'ledger';
  for (const m of models) results.push(await trial(m, { task, keep }));
  writeFileSync(process.argv[2] || 'trial.json', `${JSON.stringify(results, null, 2)}\n`);
  for (const r of results) {
    process.stdout.write(`${r.model}: hidden ${r.hidden.pass}/${r.hidden.total}, visible ${r.visible.pass}/${r.visible.total}` +
      `, own tests ${r.own_tests.files.length} file(s) ${r.own_tests.pass}/${r.own_tests.total}, ${r.secs}s, ${r.turns ?? '?'} turns` +
      `${r.visible_untouched ? '' : ', CHANGED THE VISIBLE TESTS'} ${JSON.stringify(r.signals)}${r.error ? ` — ${r.error}` : ''}\n`);
    for (const f of r.hidden.failed) process.stdout.write(`  hidden fail: ${f}\n`);
  }
}
