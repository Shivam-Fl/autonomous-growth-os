#!/usr/bin/env node
// Installs the framework into another repository.
//
//   node .sdlc/bin/install.mjs --target ../some-repo [--force [--overwrite-modified]]
//
// Copies the pipeline, scans the target to work out how it builds and tests, and writes a
// config plus seed memory. Everything it infers is labelled as inferred: an install that
// guesses silently produces CI that passes because it runs nothing, which is worse than an
// install that refuses to finish.

import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detect, forbiddenFor } from './lib/detect.js';
import { STUB_NOTE, scanFoundNothing } from './lib/project.js';
import { load } from './lib/js-yaml.mjs';

const exec = promisify(execFile);
const SRC = join(dirname(new URL(import.meta.url).pathname), '..', '..');

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf('--' + n); return i === -1 ? null : (args[i + 1]?.startsWith('--') ? true : args[i + 1]); };
const FORCE = args.includes('--force');
const target = flag('target');

if (!target) { console.error('usage: install.mjs --target <path-to-repo> [--force]'); process.exit(1); }
if (!existsSync(join(target, '.git'))) { console.error(`${target} is not a git repository`); process.exit(1); }

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const ok = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const skip = (s) => console.log(`  \x1b[33m·\x1b[0m ${s}`);
const note = (s) => console.log(`    ${s}`);

// --- 1. scan the target ------------------------------------------------------
console.log(`\n${bold('Scanning')} ${target}`);

const { stdout: tracked } = await exec('git', ['-C', target, 'ls-files'], { maxBuffer: 50 * 1024 * 1024 });
const files = tracked.split('\n').filter(Boolean);

let pkg = null;
if (existsSync(join(target, 'package.json'))) {
  try { pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')); } catch {}
}
const wfDir = join(target, '.github/workflows');
const workflows = existsSync(wfDir) ? readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)) : [];

const found = detect({ files, pkg, workflows });
ok(`${files.length} tracked files · stack: ${found.stack}${found.framework ? ` (${found.framework})` : ''}`);

// --- 2. copy the framework ---------------------------------------------------
console.log(`\n${bold('Installing')}`);

const COPY = [
  ['.github/workflows', /^(sdlc-.*|ci-verify)\.yml$/],
  // Without these there is nothing making a bug report carry repro steps, and intake then
  // stops every bug for lacking them — a gate that fires constantly is a gate people route
  // around.
  ['.github/ISSUE_TEMPLATE', /\.(yml|md)$/],
  ['.sdlc/agents', /\.md$/],
  ['.sdlc/schemas', /\.json$/],
  ['.sdlc/templates', /\.(ya?ml|md)$/],   // md: the memory stubs, so a re-install from here seeds too
  ['.sdlc/bin', null],   // includes package.json: marks the tree as ESM in any host repo
];

// Every framework file this install writes, as {from, rel}. Single files that live outside a
// copied directory are listed too: the COPY list is per-DIRECTORY with a per-directory filter,
// so anything sitting loose in .sdlc/ is invisible to it — and flow-graph.json is exactly that.
// Without it every hand-off after the first throws, the silent kind of broken this framework
// keeps finding by noticing nothing happened.
const plan = [];
for (const [dir, filter] of COPY) {
  const from = join(SRC, dir);
  if (!existsSync(from)) continue;
  for (const entry of walk(from)) {
    const rel = relative(from, entry);
    if (filter && !filter.test(rel.split('/').pop())) continue;
    plan.push({ from: entry, rel: join(dir, rel) });
  }
}
for (const rel of ['.sdlc/flow-graph.json', 'bin/sdlc']) {
  if (existsSync(join(SRC, rel))) plan.push({ from: join(SRC, rel), rel });
}

// What was installed, recorded. Without a record, a re-install could not tell an old version
// of a file from one the owner edited: without --force it skipped every existing file and left
// a mixed version (new scripts beside old workflows), and with --force it silently reverted the
// owner's edits. The manifest is the record; the refusals below are what it is for.
const MANIFEST = join(target, '.sdlc/manifest.json');
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const previous = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : null;
const OVERWRITE_MODIFIED = args.includes('--overwrite-modified');
const edited = (rel) => previous?.files?.[rel] && existsSync(join(target, rel)) && sha(join(target, rel)) !== previous.files[rel];

const refusals = [];
for (const { from, rel } of plan) {
  const dest = join(target, rel);
  if (!existsSync(dest) || sha(dest) === sha(from)) continue;
  if (!FORCE) refusals.push(`${rel} differs from this version — skipping it would leave a mixed install`);
  else if (edited(rel) && !OVERWRITE_MODIFIED) refusals.push(`${rel} was edited after it was installed`);
}
// Files the framework no longer ships, removed so they cannot keep running. Only ones the
// install wrote and nobody changed since; an edited one is the owner's to decide about.
const retired = Object.keys(previous?.files ?? {}).filter((rel) => !plan.some((p) => p.rel === rel) && existsSync(join(target, rel)));
for (const rel of retired) {
  if (FORCE && edited(rel) && !OVERWRITE_MODIFIED) refusals.push(`${rel} is no longer shipped, but was edited after it was installed`);
}
if (refusals.length) {
  console.error(`\n${bold('Refusing to install')} — nothing was written:\n${refusals.map((r) => `  - ${r}`).join('\n')}\n`);
  console.error(FORCE
    ? '  Those are your changes to framework files. Keep a copy, then re-run with --force --overwrite-modified.'
    : '  Re-run with --force to upgrade the framework (memory and config.yml are never touched).');
  process.exit(1);
}

let copied = 0;
for (const { from, rel } of plan) {
  const dest = join(target, rel);
  if (existsSync(dest) && sha(dest) === sha(from)) continue;
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(from, dest);
  copied++;
}
if (FORCE) for (const rel of retired) { rmSync(join(target, rel)); note(`removed ${rel} — no longer part of the framework`); }

const sourceSha = await exec('git', ['-C', SRC, 'rev-parse', 'HEAD']).then((r) => r.stdout.trim()).catch(() => null);
mkdirSync(dirname(MANIFEST), { recursive: true });
writeFileSync(MANIFEST, `${JSON.stringify({
  source_sha: sourceSha,
  files: Object.fromEntries(plan.map(({ from, rel }) => [rel, sha(from)])),
}, null, 2)}\n`);
ok(`${copied} files copied, ${plan.length - copied} already current · .sdlc/manifest.json records this version`);

// --- 3. config ---------------------------------------------------------------
// Same rule as memory, and for the same reason: config.yml is the PROJECT's file, not the
// framework's. It holds the allowlist, the autonomy gates, the QA allowlists and the
// forbidden paths — every deliberate choice someone made about how much this pipeline may do
// on its own. `--force` is how you upgrade the framework, and an upgrade that reset
// `merge_approval` to true and the allowlist to REPLACE_ME would look like it worked.
//
// New keys are not written in either. They are REPORTED — `sdlc doctor` lists every key this
// version expects and what it defaults to, so the choice of whether to adopt one stays with
// the person whose pipeline it is.
const cfgPath = join(target, '.sdlc/config.yml');
if (existsSync(cfgPath)) {
  skip('.sdlc/config.yml exists — not overwritten, not even with --force (it holds your gates and allowlist)');
  note('  run `sdlc doctor` in the target to see any config keys this version added');
} else {
  mkdirSync(dirname(cfgPath), { recursive: true });
  writeFileSync(cfgPath, renderConfig(found, forbiddenFor({ files })));
  ok('.sdlc/config.yml written from the scan');
}

// --- 4. seed memory ----------------------------------------------------------
// --force overwrites FRAMEWORK files. It must never overwrite memory.
//
// `--force` is how you upgrade the framework in a repo that already runs it — and memory is
// the one thing in `.sdlc/` the project owns rather than the framework. Overwriting it
// throws away the architecture the project planner decided and a human approved, plus every
// convention and QA selector the Librarian has learned, and replaces them with a scan of a
// repo whose real structure is now invisible to that scan. The upgrade would look like it
// worked, and every agent afterwards would be reading a stub.
const memDir = join(target, '.sdlc/memory');
if (existsSync(join(memDir, 'project.md'))) {
  skip('.sdlc/memory/project.md exists — not overwritten, not even with --force (memory is the project\'s, not the framework\'s)');
} else {
  mkdirSync(join(memDir, 'qa'), { recursive: true });
  mkdirSync(join(memDir, 'patterns'), { recursive: true });
  mkdirSync(join(memDir, 'decisions'), { recursive: true });
  writeFileSync(join(memDir, 'project.md'), renderProjectMemory(found, files, target));
  writeFileSync(join(memDir, 'index.md'), renderIndex());
  // patterns/ and decisions/ get their README too, and not for decoration: git does not track
  // an empty directory, so `mkdirSync` above produced two directories that vanished on the
  // first commit. index.md still linked to them, so the first agent to follow that link
  // reported the memory as missing — and QA logged "no known bug shapes to check against" as
  // a coverage gap rather than as an empty repo.
  //
  // conventions.md and qa/ come from stub templates, never from this repo's own memory. They
  // were copied from .sdlc/memory — the FRAMEWORK's conventions (js-yaml, node --test, .mjs
  // scripts) and its demo todo app's selectors — so every product's agents started out
  // following another project's rules and hunting for #new-todo.
  for (const f of ['conventions.md', 'qa/environment.md', 'qa/selectors.md',
                   'patterns/README.md', 'decisions/README.md']) {
    const src = join(SRC, f.endsWith('README.md') ? '.sdlc/memory' : '.sdlc/templates/memory', f);
    const dst = join(memDir, f);
    // Seeded when absent, never replaced. Same reason: conventions.md and qa/selectors.md are
    // where this project's own learning accumulates.
    if (existsSync(src) && !existsSync(dst)) cpSync(src, dst);
  }
  ok('.sdlc/memory seeded from the scan');
}

// --- 5. what the human has to do --------------------------------------------
//
// Reports what was WRITTEN, not what the scan found. Those differ on a greenfield repo — the
// scan finds nothing and the config is pointed at the `sdlc:` verbs the project planner will
// define — and a summary describing the scan would have told you every check is skipped while
// the file said otherwise. A setup tool that misreports its own output is worse than a silent
// one, because you act on it.
const greenfieldInstall = !Object.values(found.verify ?? {}).some(Boolean);

console.log(`\n${bold('What was inferred, and what you must check')}`);
for (const [k, v] of Object.entries(found.verify)) {
  const conf = found.confidence[k];
  if (!v && greenfieldInstall && k === 'unit') {
    ok('verify.unit: npm run sdlc:verify', '← the project planner defines that verb, once, before the first ticket');
  } else if (!v) skip(`verify.${k}: empty (${conf ?? 'none found'}) — that check will be skipped`);
  else if (conf === 'guessed') skip(`verify.${k}: ${v}  ← GUESSED, verify it runs`);
  else ok(`verify.${k}: ${v}`);
}
console.log();
for (const n of found.notes) {
  // Same reason: this note is about the scan, and on a greenfield repo the config does not
  // agree with it any more.
  if (greenfieldInstall && /could not work out how to start this app/.test(n)) {
    note('- env.boot is `npm run sdlc:serve` — the project planner decides what that runs');
    continue;
  }
  note(`- ${n}`);
}

console.log(`\n${bold('Next')}`);
console.log('  1. read .sdlc/config.yml — especially env.* and allowlist (it lists only a placeholder)');
// GitHub runs the default branch's workflows and they read the default branch's config. A
// pipeline left on disk, or on a feature branch, looks installed and starts nothing.
console.log('  2. commit .github .sdlc bin and push them to the DEFAULT branch — the runner reads that, not this disk');
console.log('  3. cd ' + target + ' && node bin/sdlc init');
// Whichever config the target ends up with decides the credential. A repo pointed at a gateway
// authenticates with the key that gateway issued (sent as x-api-key); telling it to set the
// OAuth token sent the owner to fetch a secret no agent run would ever be able to use.
const providerUrl = (() => {
  try { return load(readFileSync(cfgPath, 'utf8'))?.runtime?.provider?.base_url || ''; } catch { return ''; }
})();
console.log(providerUrl
  ? `  4. gh secret set ANTHROPIC_API_KEY  ← the key ${providerUrl} issued you (not CLAUDE_CODE_OAUTH_TOKEN)`
  : '  4. claude setup-token  →  gh secret set CLAUDE_CODE_OAUTH_TOKEN');
console.log('  5. node bin/sdlc doctor');
console.log('  6. open an issue and watch it, with gates.plan_approval left ON');
if (greenfieldInstall) {
  console.log('\n  This repo has no code yet, so the FIRST issue decides the architecture before');
  console.log('  anything is planned against it — stack, modules, invariants, the four sdlc: verbs.');
  console.log('  That lands as a PR and always waits for you. It happens once per repository.');
}
console.log();

// --- helpers -----------------------------------------------------------------
function* walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

// A scan of a repo with nothing in it finds nothing to run, and an empty `verify.unit` means
// that check is skipped. On a greenfield repo that is EVERY check — so CI passes because it
// runs nothing, which this installer's own header calls worse than refusing to finish.
//
// The project planner decides those commands, once, before the first ticket is planned. So a
// greenfield config points at the `sdlc:` verbs it is about to define, and the two stop being
// separate decisions that have to agree. Without this the planner names four verbs nothing
// calls, which is the "knob that changes nothing" failure one level up.
function renderConfig(d, forbidden) {
  const q = (s) => (s ? `"${s.replace(/"/g, '\\"')}"` : '""');
  const greenfield = !Object.values(d.verify ?? {}).some(Boolean);
  const v = greenfield
    ? { ...d.verify, unit: 'npm run sdlc:verify' }
    : d.verify;
  const boot = d.env.boot || (greenfield ? 'npm run sdlc:serve' : '');
  // api_allowlist is where the page may SEND DATA, and empty means QA refuses to run. Compose
  // boots the app on the runner, so the local hosts are known — and leaving the key out made
  // every compose install's first QA run stop with "cannot prove this is not production". A
  // preview's api host is not knowable from a scan, so it stays empty, and says why.
  const hosts = (list) => list.map((h) => `    - "${h}"`).join('\n');
  const envLines = d.env.mode === 'none'
    ? `  # No runnable surface detected, so browser QA is off. CI, review and the unit suite\n  # still gate every PR. Set this to preview or compose if the repo does ship an app.\n  mode: none`
    : d.env.mode === 'preview'
    ? `  mode: preview\n  url_allowlist:\n${hosts(d.env.url_allowlist)}\n  ready: ${q(d.env.ready)}
  ready_timeout_seconds: 0   # 0 = auto (180 preview, 420 compose)
  deploy_wait_minutes: 20    # how long QA waits for a deployment of the PR head commit
  audit_url: ""              # an audit (no PR, so no preview) and the debugger drive this; empty = refuse
  # Hosts the page may SEND DATA to. Empty = QA refuses: a preview commonly serves only a
  # frontend that inherits the PRODUCTION api url. Name a staging api here.
  api_allowlist: []`
    : `  mode: compose\n  base_url: ${q(d.env.base_url)}\n  url_allowlist:\n${hosts(d.env.url_allowlist)}\n  boot: ${q(boot)}\n  ready: ${q(d.env.ready)}
  ready_timeout_seconds: 0   # 0 = auto (180 preview, 420 compose)
  audit_url: ""              # preview mode only; compose audits drive base_url
  # Hosts the page may SEND DATA to. The app runs on this runner, so local only.
  api_allowlist:\n${hosts(d.env.api_allowlist ?? ['localhost:*', '127.0.0.1:*'])}`;

  return `# Written by \`sdlc install\` from a scan of this repo. Every value below is a starting
# point, not a fact — read it before you trust the pipeline with anything.
#
# Detected stack: ${d.stack}${d.framework ? ` (${d.framework})` : ''}
${d.notes.map((n) => `#   - ${n}`).join('\n')}

runtime:
  # Where the models come from. Empty = Anthropic direct with the action's OAuth token,
  # which is what every repo did before this block existed.
  #
  # A gateway lets runtime.model.<stage> name ANY model it serves, so stages can sit on
  # different models — which matters when quotas are per model rather than pooled.
  #
  # Header names are load-bearing. OpenCode Go refuses Authorization: Bearer with
  # "Missing API key" and wants x-api-key — ANTHROPIC_API_KEY sends that,
  # ANTHROPIC_AUTH_TOKEN does not. It also answers a missing x-opencode-session with an
  # opaque 500 on its Anthropic endpoint, which is a 400 wearing the wrong number.
  # {run} in a header value becomes the Actions run id: one stable id per conversation.
  provider:
    base_url: ""        # e.g. https://opencode.ai/zen/go  — NO trailing /v1: the action
                        # appends /v1/messages itself, and a doubled /v1 returns a 404 that
                        # the client reports as a missing model
    headers: {}         # e.g. { x-opencode-session: "sdlc-{run}" }
    # Models this gateway serves only on the OpenAI API (e.g. glm-5.3-flash, kimi-k2.7-code on
    # OpenCode Go). Claude Code speaks only Anthropic Messages, so a job running one starts a local
    # LiteLLM translator; "sdlc doctor --live --bridge <m> --agent" proves a model works through it.
    openai_models: []
  # Model per STEP. Empty = the action's default — a CLAUDE model, so with a provider above
  # every step must name a model that provider serves (claude-args refuses otherwise, and so
  # does doctor). A council member inherits its stage only when its key is absent.
  # Spend where a mistake is hardest to recover from: the diagnosis every later stage
  # inherits, and the last read before code is trusted.
  model:
    plan:               claude-opus-5
    plan_proposer:      ""
    plan_critic:        ""
    plan_arbiter:       claude-opus-5
    plan_reviewer:      claude-opus-5
    debug:              claude-opus-5
    implement:          ""
    review:             claude-opus-5
    review_correctness: ""
    review_design:      ""
    qa:                 ""
    root_cause:         ""
    # Reads a whole failed run's log and decides what the failure MEANS — the one step whose
    # wrong answer spends another agent's entire run.
    triage:             claude-opus-5
    librarian:          ""
    release:            ""
    maintainer:         claude-opus-5
    # Decides the stack once, for the life of the repo. The one place to spend the most
    # capable model you have.
    project:            claude-opus-5
    # Decides WHICH STAGES a ticket needs, and only when the free rules decline. It runs on
    # every issue they miss, so this is the one step where model cost is a tax on the whole
    # backlog. Never Opus: classifying a ticket is not the hard part of this pipeline.
    router:             claude-haiku-4-5-20251001

  # Turn limits. EMPTY MEANS NO LIMIT, which is the default and usually right: the action
  # validates the count after the run, so exceeding a cap discards completed work instead of
  # truncating it. limits.attempts and timeout-minutes already stop runaway beforehand.
  max_turns: {}

# single = one agent. council = several in sequence, each reading the last one's output.
# A council costs roughly 3x the turns. Start single; switch the stage that actually
# produces bad output.
councils:
  plan:   single           # single | council
  review: single           # single | council

# Where agent PRs are opened against, and what QA diffs them from. Empty = the repo's
# default branch. Set this when the team integrates somewhere else — many repos keep
# main/master as the released state and merge to a development branch.
base_branch: ""

# Bugs go to the debugger, which reproduces in a live browser before diagnosing.
route_bugs_to_debugger: true

# Which stages a ticket actually needs. The Router composes a route out of
# .sdlc/flow-graph.json: deterministic rules first (free, and it names the rule that fired),
# a cheap model only for what those rules will not commit to.
route:
  enabled:   true    # false = every issue gets the full chain
  fast_path: true    # false = skip the free rules and always ask the model

# The environment QA drives. url_allowlist is the guard that stops an agent clicking
# through production — QA refuses to open a browser against anything not matching it.
env:
${envLines}

# The debugger gets different rules from QA, on purpose. Reproducing a reported bug often
# REQUIRES production — the bug exists there, with that account and that data. QA is the
# opposite: adversarial and broad, so it needs a target it is free to break.
debug_env:
  allow_production: false
  url_allowlist: []
  api_allowlist: []
  read_only: true

# How QA logs in.
# none    = the app has no login, or QA only tests unauthenticated flows
# fixture = plaintext credentials for an ephemeral stack. Verifies env.mode is compose and
#           api_allowlist is local-only before it will hand them over.
# secrets = accounts provisioned by hand (SSO, admin). Values come from GitHub Secrets;
#           only their NAMES appear here.
# derived = QA signs itself up, every password an HMAC of one QA_FIXTURE_SEED secret.
#
# Derived rather than "sign up and save the credentials" because there is nowhere safe to
# save them: memory/ and the ledger are both git. Deriving stores nothing, yields the same
# password for the same identity so accounts are reusable, and rotating the seed rotates all.
qa_auth:
  mode: none               # none | fixture | secrets | derived

  # mode: secrets — secret NAMES, never values. One entry per role: most apps need two
  # accounts to test anything about permissions, and roles rarely share a credential shape
  # (a customer may log in by phone and OTP while an owner uses a password).
  accounts:
    - role: primary
      fields: { email: QA_USER_EMAIL, password: QA_USER_PASSWORD }
  scope: pr                # run | pr | global
  roles: [primary]         # add a second for permission tests
  email_domain: qa.invalid # RFC 2606 reserved — can never reach a real person
  signup_url: "/signup"    # CHECK THIS against the app before the first QA run

# own      = run the checks below (a repo with no CI of its own)
# existing = skip them; this repo's CI already gates the PR, and the pipeline waits for those
#            checks instead of running a weaker duplicate beside them
# both     = run ours alongside theirs
verify:
  mode: ${d.verifyMode ?? 'own'}

  # Which checks must pass before an agent may look at the PR. Empty = every check on the PR
  # except the pipeline's own. Name them explicitly on a repo with optional or slow jobs.
  required_checks: []
  wait_minutes: 60

  # Runs before every other check. Monorepos usually need codegen or a shared package built
  # first, or typecheck fails for reasons unrelated to the PR.
  prepare:   ${q(v.prepare ?? '')}
  typecheck: ${q(v.typecheck)}
  lint:      ${q(v.lint)}
  unit:      ${q(v.unit)}
  build:     ${q(v.build)}
  e2e:       ${q(v.e2e)}

gates:
  plan_approval:     true   # a HUMAN approves the work order before any code is written
  plan_review_agent: true   # when plan_approval is off, an agent reviews instead of nobody
  min_confidence:    70     # a plan below this reaches a human regardless of the gates above
  merge_approval:    true
  qa_files_issues:   true   # QA opens issues for bugs outside this PR's scope
  min_route_confidence: 70   # a ROUTE below this reaches a human, absent counts as below
  max_route_risk:       70   # and so does a route through something this expensive to get wrong

limits:
  attempts: 10
  runtime_retries: 4       # provider-outage cooldowns one stage may wait through before it
                           # stops for a person. The waits back off 20/40/80/120 minutes.
  max_in_flight: 2         # how many issues may be mid-pipeline at once. Every agent stage

                           # runs on ONE token, and ten concurrent sessions exhausted it in a

                           # single minute — plan, review and implement all failing together.

                           # 0 = no cap, which is what a fan-out of eight will do to you.

  lock_ttl_minutes: 300    # must exceed the longest job, or the watchdog reclaims a lock
                         # from a stage that is still running and two agents write at once
  repeat_failure_escalate: 2   # the same failure twice puts the PLAN on trial, not the code

# No agent may touch these without a human. Derived from what this repo actually contains.
forbidden_paths:
${forbidden.map((p) => `  - "${p}"`).join('\n')}

# Only these users may issue /sdlc commands. Everyone else's comments are data, never
# instructions. REPLACE THIS — an install cannot know who owns the repo.
allowlist:
  - "REPLACE_ME"

maintainer:
  club_if_under_files: 6   # adjacent pieces this small together are a candidate to be one issue

  flag_chain_of: 3         # a straight line of this many dependent issues gets a second look
  flag_similarity: 0.5     # how alike two adjacent titles read before that look is worth it

# Numbered section by section for the project planner, whose brief must account for every one.
# Files, or directories of .md; when none exists, the project issue itself is the spec.
spec:
  paths: ["docs/spec", "SPEC.md"]

# How merge-pr merges a PR that passed QA: squash, merge or rebase (gh pr merge --<method>).
release:
  merge_method: squash
`;
}

function renderProjectMemory(d, files, target) {
  const top = [...new Set(files.map((f) => f.split('/')[0]).filter((s) => !s.includes('.')))]
    .slice(0, 15);

  // A scan of a repo with nothing in it produces a file that says "_flat repository_" and
  // "_none detected_" — and that reads, to every agent downstream, exactly like a project
  // whose stack happens to be nothing. So it says it is a stub, in a marker a script wrote
  // and a script reads, rather than leaving the next reader to infer it from prose.
  const stub = scanFoundNothing(d, files) ? `${STUB_NOTE}\n\n` : '';

  return `${stub}# Project

Seeded by \`sdlc install\` from a scan. **Correct it** — an agent reads this before planning,
and a wrong entry here steers every ticket wrong.

## Stack
${d.stack}${d.framework ? ` (${d.framework})` : ''} · ${files.length} tracked files

## Top-level layout
${top.map((t) => `- \`${t}/\``).join('\n') || '_flat repository_'}

## Commands
${Object.entries(d.verify).filter(([, v]) => v).map(([k, v]) => `- ${k}: \`${v}\``).join('\n') || '_none detected — fill these in_'}

## Non-obvious
_Empty. This is the most valuable section and a scan cannot write it._

Add what a newcomer gets wrong: which module owns what, the abstraction that looks
redundant but is not, the test that is slow for a reason, the service that must be running
locally. The Librarian appends here as the system learns, but it starts from what you write.
`;
}

function renderIndex() {
  return `# Memory index

One line per entry, describing **when it applies** — an agent reads this before deciding
whether to open the entry itself.

## Always
- [project.md](project.md) — stack, layout, commands. Read before any planning.
- [conventions.md](conventions.md) — naming, errors, tests, PR style. Read before writing code.

## Situational
- [qa/environment.md](qa/environment.md) — env quirks and login recipes. Read before browser QA.
- [qa/selectors.md](qa/selectors.md) — selectors known to be stable.
- [patterns/](patterns/) — bug shapes this repo has produced before. Grep by symptom.
- [decisions/](decisions/) — why things are as they are. Read before proposing a rewrite.
`;
}
