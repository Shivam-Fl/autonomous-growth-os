#!/usr/bin/env node
// Interactive setup. One command, from inside the repo you want to automate.
//
//   npx github:Shivam-Fl/automated-ai-sdlc setup
//
// The rule this is built on: ASK ONLY WHAT CANNOT BE DETECTED, and show the detected value
// as the default. Installing into printQ took eleven manual steps and five follow-up PRs,
// and almost every one of them was a value a program could have read from the repo — the CI
// job name, the migrations directory, the preview host, the signup route. Every question
// below exists because it is genuinely a judgement call, not because reading was hard.
//
// It never handles a secret value. Those go through `gh secret set`, which prompts directly.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { detect, forbiddenFor } from './lib/detect.js';
import { heading, say, note, detected, ask, confirm, choose, closePrompts, interactive, colour as C } from './lib/prompt.js';

const exec = promisify(execFile);
const sh = async (cmd, args, opts = {}) => (await exec(cmd, args, { maxBuffer: 5e7, ...opts })).stdout.trim();
const gh = (args) => sh('gh', args);
const quiet = (p) => p.catch(() => null);

const root = process.cwd();
const answers = {};

// --- preflight ---------------------------------------------------------------
heading('Checking your setup');
if (!interactive()) {
  note('Not a terminal (or --yes) — taking every default. Read .sdlc/config.yml before trusting it.');
}

try { await sh('gh', ['--version']); } catch {
  say(`  ${C.yellow('gh is not installed')} — this needs it. brew install gh`);
  process.exit(1);
}
const me = JSON.parse(await gh(['api', 'user']));
detected('signed in as', me.login);

const repo = await quiet(gh(['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef,visibility']))
  .then((r) => (r ? JSON.parse(r) : null));
if (!repo) {
  say(`  ${C.yellow('not inside a GitHub repository')} — run this from a cloned repo.`);
  process.exit(1);
}
detected('repository', `${repo.nameWithOwner} (${repo.visibility.toLowerCase()})`);

const scopes = await quiet(exec('gh', ['auth', 'status']).then((r) => r.stdout + r.stderr).catch((e) => e.stdout + e.stderr));
for (const need of ['repo', 'workflow']) {
  if (!String(scopes).includes(`'${need}'`)) {
    say(`  ${C.yellow(`missing the "${need}" scope`)} — gh auth refresh -h github.com -s ${need}`);
    process.exit(1);
  }
}

// --- scan --------------------------------------------------------------------
heading('Reading your repository');

const files = (await sh('git', ['ls-files'])).split('\n').filter(Boolean);
const pkg = existsSync(join(root, 'package.json'))
  ? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) : null;
const wfDir = join(root, '.github/workflows');
const workflows = existsSync(wfDir)
  ? (await sh('ls', [wfDir])).split('\n').filter((f) => /\.ya?ml$/.test(f)) : [];

const found = detect({ files, pkg, workflows });
detected('files', files.length);
detected('stack', found.stack + (found.framework ? ` (${found.framework})` : ''));
if (pkg?.workspaces) detected('monorepo', 'yes — npm workspaces');

// --- 1. who is trusted --------------------------------------------------------
heading('Who can command the pipeline');
note('Comments are untrusted input. Only these accounts may run /sdlc approve, merge or override.');
answers.allowlist = (await ask('GitHub usernames, comma separated', me.login))
  .split(',').map((s) => s.trim()).filter(Boolean);

// --- 2. where PRs land --------------------------------------------------------
heading('Where agent PRs go');
const branches = JSON.parse(await gh(['api', `repos/${repo.nameWithOwner}/branches?per_page=100`]))
  .map((b) => b.name);
const dflt = repo.defaultBranchRef.name;
const likelyIntegration = ['development', 'develop', 'dev', 'staging'].find((b) => branches.includes(b));
if (likelyIntegration) {
  note(`Your default branch is "${dflt}", but "${likelyIntegration}" also exists.`);
  note('A PR opened against the wrong base carries every unrelated commit between the two');
  note('branches in its diff, which misleads the reviewer and QA long before the merge.');
}
answers.base_branch = await ask('Base branch for agent PRs', likelyIntegration ?? dflt);

// Protected branches that require checks an agent PR cannot satisfy make every PR unmergeable.
const protection = await quiet(gh(['api', `repos/${repo.nameWithOwner}/branches/${answers.base_branch}/protection`]));
if (protection) {
  const req = JSON.parse(protection).required_status_checks?.contexts ?? [];
  if (req.length) {
    note(`"${answers.base_branch}" requires: ${req.join(', ')}`);
    note('Agent PRs must satisfy these too, or they will sit unmergeable.');
  }
  const reviews = JSON.parse(protection).required_pull_request_reviews;
  if (reviews) note('It also requires a human review — the pipeline cannot approve its own PRs.');
}

// --- 3. what gates a PR -------------------------------------------------------
heading('What must pass before an agent looks at a PR');
const theirCI = workflows.filter((w) => !w.startsWith('sdlc-') && w !== 'ci-verify.yml');
if (theirCI.length) {
  detected('existing CI', theirCI.join(', '));
  note('Running our own checks beside yours burns minutes and gates on less than you trust.');
}
answers.verifyMode = await choose('How should PRs be verified?', [
  { value: 'existing', label: 'Wait for the CI you already have', detail: 'Recommended when you have CI. Nothing duplicated.' },
  { value: 'own', label: 'Run the framework\'s own checks', detail: 'For a repo with no CI of its own.' },
  { value: 'both', label: 'Both', detail: 'Rarely what you want.' },
], { fallback: theirCI.length ? 0 : 1 });

answers.required_checks = [];
if (answers.verifyMode !== 'own') {
  // Ground truth, not inference: ask GitHub what checks actually ran on a recent PR.
  //
  // Deriving names from workflow YAML gets them subtly wrong — the reported name depends on
  // the workflow name, the job name, matrix expansion and reusable-workflow nesting, and a
  // first attempt here produced "CI / CI / check" and, before that, "workflow_dispatch".
  // A name that does not match is a check the gate waits for forever.
  let guess = [];
  const recent = await quiet(gh(['pr', 'list', '--state', 'all', '--limit', '5', '--json', 'number']))
    .then((r) => (r ? JSON.parse(r) : []));
  for (const pr of recent) {
    const roll = await quiet(gh(['pr', 'view', String(pr.number), '--json', 'statusCheckRollup']));
    if (!roll) continue;
    const names = (JSON.parse(roll).statusCheckRollup ?? [])
      .map((c) => c.name ?? c.context)
      .filter(Boolean)
      .filter((n) => !/^(sdlc-|gate$|verify$|qa$|command$|merged$)/.test(n));
    if (names.length) { guess = [...new Set(names)]; break; }
  }
  if (guess.length) note(`Checks seen on a recent PR: ${guess.join(', ')}`);
  else note('No previous PR to read check names from — leave blank to wait for all of them.');

  const picked = await ask('Checks that must pass (comma separated, blank = all)', guess.slice(0, 2).join(','));
  answers.required_checks = picked.split(',').map((s) => s.trim()).filter(Boolean);
}

// --- 4. how QA reaches the app ------------------------------------------------
heading('How QA reaches a running app');
note('QA is adversarial: it double-submits, probes permissions and tries to break things.');
note('It needs somewhere it is free to wreck.');

answers.envMode = await choose('Where should QA test?', [
  { value: 'preview', label: 'A per-PR preview deployment', detail: 'Vercel, Netlify, Render, Fly. Highest fidelity — the real build artifact.' },
  { value: 'compose', label: 'Boot the app on the runner', detail: 'Ephemeral database, destroyed with the run. Nothing can reach production.' },
  { value: 'none', label: 'No browser QA', detail: 'A library, or nothing runnable. CI and review still gate every PR.' },
], { fallback: found.env.mode === 'preview' ? 0 : found.env.mode === 'none' ? 2 : 1 });

answers.env = { mode: answers.envMode };
if (answers.envMode === 'preview') {
  answers.env.url_allowlist = (await ask('Host patterns QA may open', (found.env.url_allowlist ?? ['*.vercel.app']).join(',')))
    .split(',').map((s) => s.trim()).filter(Boolean);

  say('');
  note(C.yellow('This next one is the guard that actually matters.'));
  note('A preview often serves only a frontend while inheriting the PRODUCTION api url.');
  note('The page then passes the host check above while every write lands in production.');
  note('Leave it blank and QA refuses to run — which is correct until you have a staging api.');
  answers.env.api_allowlist = (await ask('Hosts QA may SEND DATA to (blank = block QA)', ''))
    .split(',').map((s) => s.trim()).filter(Boolean);
} else if (answers.envMode === 'compose') {
  answers.env.base_url = await ask('URL the app serves on', found.env.base_url ?? 'http://localhost:3000');
  answers.env.boot = await ask('Command that starts it', found.env.boot ?? '', {
    hint: 'Runs on the runner. Multi-step is fine — docker compose up, migrate, seed, then serve.',
  });
  answers.env.url_allowlist = ['localhost:*'];
  answers.env.api_allowlist = ['localhost:*'];
  answers.env.ready_timeout_seconds = 600;
}
answers.env.ready = answers.envMode === 'none' ? '' : await ask('Path that returns 200 when up', found.env.ready ?? '/');

// --- 5. login -----------------------------------------------------------------
answers.qa_auth = { mode: 'none' };
if (answers.envMode !== 'none') {
  heading('How QA logs in');
  answers.qa_auth.mode = await choose('Does the app need a login?', [
    { value: 'none', label: 'No login needed', detail: 'QA tests unauthenticated flows only.' },
    { value: 'fixture', label: 'Seeded accounts, credentials in config', detail: 'Only for compose: the database is built empty and destroyed with the run.' },
    { value: 'secrets', label: 'Real accounts, values in GitHub Secrets', detail: 'For SSO, admin roles, anything that cannot be self-created.' },
    { value: 'derived', label: 'QA signs itself up', detail: 'Passwords derived from one seed secret. Nothing is stored anywhere.' },
  ], { fallback: 0 });

  if (answers.qa_auth.mode !== 'none') {
    note('Two roles let QA prove one user cannot see another\'s data — the highest-value test there is.');
    const roles = (await ask('Role names, comma separated', 'primary,secondary'))
      .split(',').map((s) => s.trim()).filter(Boolean);
    answers.qa_auth.accounts = [];
    for (const role of roles) {
      const fields = (await ask(`  fields for "${role}"`, 'email,password',
        { hint: 'e.g. email,password — or phone,otp if that is how this app logs in' }))
        .split(',').map((s) => s.trim()).filter(Boolean);
      answers.qa_auth.accounts.push({
        role,
        fields: Object.fromEntries(fields.map((f) => [
          f,
          answers.qa_auth.mode === 'fixture' ? '' : `QA_${role.toUpperCase()}_${f.toUpperCase()}`,
        ])),
      });
    }
  }
}

// --- 6. gates -----------------------------------------------------------------
heading('Human gates');
note('Approving a bad plan costs an implementation, a CI run and a QA cycle, and produces a');
note('PR that looks finished. Rejecting a good one costs a replan. Keep these on at first.');
answers.gates = {
  plan_approval: await confirm('Approve each plan before code is written?', true),
  merge_approval: await confirm('Approve each merge after QA passes?', true),
};
answers.gates.plan_review_agent = answers.gates.plan_approval
  ? true
  : await confirm('Have an agent review plans instead of nobody?', true);

// --- write --------------------------------------------------------------------
heading('Writing configuration');
mkdirSync(join(root, '.sdlc'), { recursive: true });
writeFileSync(join(root, '.sdlc/config.yml'), renderConfig(answers, found, forbiddenFor({ files })));
say(`  ${C.green('✓')} .sdlc/config.yml`);

say('');
say(`${C.bold('Next')} — these cannot be done from a config file:`);
say('');
say(`  ${C.cyan('1.')} node bin/sdlc init        ${C.dim('# labels, state branch, kill switch')}`);
say(`  ${C.cyan('2.')} gh secret set CLAUDE_CODE_OAUTH_TOKEN --app actions`);
say(`     ${C.dim('reuse an existing token — `claude setup-token` REVOKES the previous one')}`);
if (answers.qa_auth.mode === 'secrets') {
  for (const a of answers.qa_auth.accounts) {
    for (const s of Object.values(a.fields)) say(`  ${C.cyan(' →')} gh secret set ${s} --app actions`);
  }
}
if (answers.qa_auth.mode === 'derived') say(`  ${C.cyan(' →')} gh secret set QA_FIXTURE_SEED --app actions`);
say(`  ${C.cyan('3.')} node bin/sdlc doctor      ${C.dim('# verifies every one of the above')}`);
say('');
if (answers.envMode === 'preview' && !answers.env.api_allowlist.length) {
  say(`  ${C.yellow('QA is blocked')} until env.api_allowlist names a non-production api host.`);
  say(`  ${C.dim('That is deliberate — an unprovable environment is treated as production.')}`);
  say('');
}

closePrompts();

// ------------------------------------------------------------------------------
function renderConfig(a, d, forbidden) {
  const list = (arr, indent = '    ') => (arr?.length ? arr.map((x) => `${indent}- "${x}"`).join('\n') : `${indent}[]`);
  const envBlock = a.envMode === 'none'
    ? '  mode: none   # nothing runnable to drive'
    : a.envMode === 'preview'
      ? [`  mode: preview`, `  url_allowlist:`, list(a.env.url_allowlist),
         `  # Hosts the page may SEND DATA to. Empty = QA refuses to run, because a preview`,
         `  # that serves only a frontend commonly inherits the PRODUCTION api url.`,
         `  api_allowlist:`, list(a.env.api_allowlist), `  ready: "${a.env.ready}"`].join('\n')
      : [`  mode: compose`, `  base_url: "${a.env.base_url}"`,
         `  url_allowlist:`, list(a.env.url_allowlist), `  api_allowlist:`, list(a.env.api_allowlist),
         `  ready: "${a.env.ready}"`, `  ready_timeout_seconds: ${a.env.ready_timeout_seconds ?? 0}`,
         `  boot: |`, ...(a.env.boot || '').split('\n').map((l) => `    ${l}`)].join('\n');

  const authBlock = a.qa_auth.mode === 'none'
    ? '  mode: none'
    : [`  mode: ${a.qa_auth.mode}`, '  accounts:',
       ...a.qa_auth.accounts.flatMap((acc) => [
         `    - role: ${acc.role}`,
         `      fields: { ${Object.entries(acc.fields).map(([k, v]) => `${k}: ${v ? v : '""'}`).join(', ')} }`,
       ])].join('\n');

  return `# Written by \`sdlc setup\` from your answers and a scan of this repo.
# Detected: ${d.stack}${d.framework ? ` (${d.framework})` : ''}, ${d.size ?? '?'} files.

runtime:
  model:
    plan:       claude-opus-5   # the diagnosis every later stage inherits
    review:     claude-opus-5   # the last read before code is trusted
    debug:      claude-opus-5
    implement:  ""              # applies a decided plan — mechanical on purpose
    qa:         ""
    maintainer: claude-opus-5   # holds the whole project; the widest context of any step
    project:    claude-opus-5   # decides the stack once, for the life of the repo
    router:     claude-haiku-4-5-20251001
                                # decides which stages a ticket needs, and only when the free
                                # rules decline. Runs on every issue they miss — never Opus.

  # No turn caps. The action validates the count AFTER a run, so exceeding a cap discards
  # finished work rather than truncating it. limits.attempts and timeout-minutes bound
  # runaway beforehand, which is when bounding is worth anything.
  max_turns: {}

councils:
  plan:   single   # single | council — a council costs ~3x, start single
  review: single

route_bugs_to_debugger: true

# Which stages a ticket actually needs. The Router composes a route out of
# .sdlc/flow-graph.json: deterministic rules first (free, and it names the rule that fired),
# a cheap model only for what those rules will not commit to.
route:
  enabled:   true    # false = every issue gets the full chain
  fast_path: true    # false = skip the free rules and always ask the model
base_branch: "${a.base_branch}"

env:
${envBlock}

# The debugger may reach production, because that is where reported bugs live. QA may not,
# because its job is to break things. read_only means: reproduce and observe, never mutate
# beyond what the repro needs, never touch a record it did not create.
debug_env:
  allow_production: false
  url_allowlist: []
  api_allowlist: []
  read_only: true

qa_auth:
${authBlock}

verify:
  mode: ${a.verifyMode}
  required_checks:
${list(a.required_checks, '    ')}
  wait_minutes: 30
  prepare:   ${q(d.verify.prepare)}
  typecheck: ${q(d.verify.typecheck)}
  lint:      ${q(d.verify.lint)}
  unit:      ${q(d.verify.unit)}
  build:     ${q(d.verify.build)}
  e2e:       ${q(d.verify.e2e)}

gates:
  plan_approval:     ${a.gates.plan_approval}
  plan_review_agent: ${a.gates.plan_review_agent}
  min_confidence:    70
  merge_approval:    ${a.gates.merge_approval}
  qa_files_issues:   true
  min_route_confidence: 70   # a ROUTE below this reaches a human, absent counts as below
  max_route_risk:       70   # and so does a route through something this expensive to get wrong

limits:
  attempts: 10
  minutes:  120
  lock_ttl_minutes: 45
  repeat_failure_escalate: 2   # the same failure twice puts the PLAN on trial, not the code

# No agent may touch these. Includes the framework's own prompts, scripts and schemas —
# a pipeline that can rewrite its own rules has none.
forbidden_paths:
${list(forbidden, '  ')}

allowlist:
${list(a.allowlist, '  ')}

maintainer:
  club_if_under_files: 6   # adjacent pieces this small together are a candidate to be one issue

  flag_chain_of: 3         # a straight line of this many dependent issues gets a second look
  flag_similarity: 0.5     # how alike two adjacent titles read before that look is worth it

release:
  auto_merge: false
  auto_tag:   false
  changelog:  "CHANGELOG.md"
`;
  function q(v) { return v ? `"${String(v).replace(/"/g, '\\"')}"` : '""'; }
}
