#!/usr/bin/env node
// Interactive setup of .sdlc/config.yml, from inside the repo you want to automate.
//
//   npx github:Shivam-Fl/automated-ai-sdlc setup
//
// It writes the config only. The framework files come from `sdlc install --target`, then
// `sdlc init` creates labels and the state branch, and `sdlc doctor --live` proves it end to end.
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
import { ROLES, providerProblem } from './claude-args.mjs';
import { load, dump } from './lib/js-yaml.mjs';

// Anthropic-direct defaults; a step not named here gets the action's default. The step list
// itself is claude-args', so a new step can never be missing from a generated config — triage
// was, and on a provider repo it ran a Claude model against a gateway that serves none.
const DIRECT_MODELS = {
  plan: 'claude-opus-5', plan_arbiter: 'claude-opus-5', plan_reviewer: 'claude-opus-5',
  debug: 'claude-opus-5', review: 'claude-opus-5', triage: 'claude-opus-5',
  maintainer: 'claude-opus-5', project: 'claude-opus-5', router: 'claude-haiku-4-5-20251001',
};

// stdin closed: execFile leaves the child's stdin an open pipe, and a child that reads it (a gh
// that decides to prompt) waits forever while setup prints nothing.
const execP = promisify(execFile);
const exec = (cmd, args, opts = {}) => {
  const p = execP(cmd, args, opts);
  p.child.stdin.end();
  return p;
};
const sh = async (cmd, args, opts = {}) => (await exec(cmd, args, { maxBuffer: 5e7, ...opts })).stdout.trim();
const gh = (args) => sh('gh', args);
const quiet = (p) => p.catch(() => null);

const root = process.cwd();
const answers = {};
const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(`--${name}`); return i === -1 ? undefined : argv[i + 1]; };

// --- preflight ---------------------------------------------------------------
heading('Checking your setup');
if (!interactive()) {
  note('Not a terminal (or --yes) — taking every default. Read .sdlc/config.yml before trusting it.');
}

// An existing config holds choices nobody can re-derive: the allowlist, the provider, the gates.
// setup used to write the whole file from its questions regardless, so re-running it to change
// one answer reset merge_approval, replaced the allowlist with the current login and dropped the
// provider block. Now it refuses; with --force it asks with the current values as the defaults
// and changes only the keys its questions cover.
const cfgFile = join(root, '.sdlc/config.yml');
const existing = existsSync(cfgFile) ? (load(readFileSync(cfgFile, 'utf8')) ?? {}) : null;
if (existing && !argv.includes('--force')) {
  say(`  ${C.yellow('.sdlc/config.yml already exists')} — it holds your allowlist, gates and provider.`);
  note('Re-run with --force to change only what you answer here; everything else is kept.');
  process.exit(1);
}
/** The existing config's value at a dotted path, else the question's own default. */
const was = (path, fallback) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), existing) ?? fallback;
/** The index of the existing answer among a choice's options, else the choice's own default. */
const pick = (options, value, fallback) => { const i = options.findIndex((o) => o.value === value); return i === -1 ? fallback : i; };
const csv = (list) => (Array.isArray(list) ? list.join(',') : '');

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
answers.allowlist = (await ask('GitHub usernames, comma separated',
  csv(was('allowlist', []).filter((u) => String(u).toLowerCase() !== 'replace_me')) || me.login))
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
answers.base_branch = await ask('Base branch for agent PRs', was('base_branch', '') || likelyIntegration || dflt);

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
  // Not the default, for the reason detect.js gives: GitHub starts no pull_request run for the
  // pipeline's bot pushes, so that CI never reports on its PRs and the gate would wait forever.
  note('Your CI never runs on the pipeline\'s PRs (GitHub starts no pull_request run for its bot');
  note('pushes) unless it also runs on workflow_dispatch and posts a commit status.');
}
const verifyOptions = [
  { value: 'existing', label: 'Wait for the CI you already have', detail: 'Only if it runs on workflow_dispatch and posts a commit status.' },
  { value: 'own', label: 'Run the framework\'s own checks', detail: 'Recommended: ci-verify is dispatched for every pipeline PR.' },
  { value: 'both', label: 'Both', detail: 'Rarely what you want.' },
];
answers.verifyMode = await choose('How should PRs be verified?', verifyOptions,
  { fallback: pick(verifyOptions, was('verify.mode'), 1) });

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

  const picked = await ask('Checks that must pass (comma separated, blank = all)',
    csv(was('verify.required_checks', [])) || guess.slice(0, 2).join(','));
  answers.required_checks = picked.split(',').map((s) => s.trim()).filter(Boolean);
}

// The pipeline merges its own PRs and every agent job holds a write token. With no protection,
// any of them can push straight to the base branch, around the gate, review and QA; with a
// required approving review, nothing can merge at all, because the pipeline cannot approve its
// own PR. A required check and no required review is the one setting both hold under — and it
// takes the owner's credentials to set, which is why it is offered here and not done by init.
const wantedChecks = answers.required_checks.length ? answers.required_checks
  : answers.verifyMode === 'existing' ? [] : ['ci-verify'];
const requiredNow = protection ? (JSON.parse(protection).required_status_checks?.contexts ?? []) : [];
if (wantedChecks.some((c) => !requiredNow.includes(c))) {
  const put = ['api', '-X', 'PUT', `repos/${repo.nameWithOwner}/branches/${answers.base_branch}/protection`,
    '-F', 'required_status_checks[strict]=false',
    ...wantedChecks.flatMap((c) => ['-f', `required_status_checks[contexts][]=${c}`]),
    '-F', 'enforce_admins=false', '-F', 'required_pull_request_reviews=null', '-F', 'restrictions=null'];
  note(`"${answers.base_branch}" does not require ${wantedChecks.join(', ')}, so an agent's token can push to it directly.`);
  // Default yes only at a terminal: --yes must not rewrite someone's branch protection unasked.
  // Boolean(): interactive() is undefined off a TTY, and undefined selects confirm's default of yes.
  if (await confirm(`Protect "${answers.base_branch}": require ${wantedChecks.join(', ')}, no approving review? (replaces its current protection)`, Boolean(interactive()))) {
    await gh(put)
      .then(() => say(`  ${C.green('✓')} ${answers.base_branch} is protected`))
      .catch((e) => say(`  ${C.yellow('could not protect it')} — ${String(e.message).split('\n')[0]} (needs admin)`));
  } else note(`doctor fails until it is: gh ${put.join(' ')}`);
}

// --- 4. how QA reaches the app ------------------------------------------------
heading('How QA reaches a running app');
note('QA is adversarial: it double-submits, probes permissions and tries to break things.');
note('It needs somewhere it is free to wreck.');

const envOptions = [
  { value: 'preview', label: 'A per-PR preview deployment', detail: 'Vercel, Netlify, Render, Fly. Highest fidelity — the real build artifact.' },
  { value: 'compose', label: 'Boot the app on the runner', detail: 'Ephemeral database, destroyed with the run. Nothing can reach production.' },
  { value: 'none', label: 'No browser QA', detail: 'A library, or nothing runnable. CI and review still gate every PR.' },
];
answers.envMode = await choose('Where should QA test?', envOptions,
  { fallback: pick(envOptions, was('env.mode'), found.env.mode === 'preview' ? 0 : found.env.mode === 'none' ? 2 : 1) });

answers.env = { mode: answers.envMode };
if (answers.envMode === 'preview') {
  answers.env.url_allowlist = (await ask('Host patterns QA may open',
    csv(was('env.url_allowlist', [])) || (found.env.url_allowlist ?? ['*.vercel.app']).join(',')))
    .split(',').map((s) => s.trim()).filter(Boolean);

  say('');
  note(C.yellow('This next one is the guard that actually matters.'));
  note('A preview often serves only a frontend while inheriting the PRODUCTION api url.');
  note('The page then passes the host check above while every write lands in production.');
  note('Leave it blank and QA refuses to run — which is correct until you have a staging api.');
  answers.env.api_allowlist = (await ask('Hosts QA may SEND DATA to (blank = block QA)', csv(was('env.api_allowlist', []))))
    .split(',').map((s) => s.trim()).filter(Boolean);
} else if (answers.envMode === 'compose') {
  answers.env.base_url = await ask('URL the app serves on', was('env.base_url', found.env.base_url ?? 'http://localhost:3000'));
  answers.env.boot = await ask('Command that starts it', was('env.boot', found.env.boot ?? ''), {
    hint: 'Runs on the runner. Multi-step is fine — docker compose up, migrate, seed, then serve.',
  });
  answers.env.url_allowlist = ['localhost:*'];
  answers.env.api_allowlist = ['localhost:*', '127.0.0.1:*'];
  answers.env.ready_timeout_seconds = was('env.ready_timeout_seconds', 600);
}
if (answers.envMode !== 'none') answers.env.ready = await ask('Path that returns 200 when up', was('env.ready', found.env.ready ?? '/'));

// --- 5. login -----------------------------------------------------------------
answers.qa_auth = { mode: 'none' };
if (answers.envMode !== 'none') {
  heading('How QA logs in');
  const authOptions = [
    { value: 'none', label: 'No login needed', detail: 'QA tests unauthenticated flows only.' },
    { value: 'fixture', label: 'Seeded accounts, credentials in config', detail: 'Only for compose: the database is built empty and destroyed with the run.' },
    { value: 'secrets', label: 'Real accounts, values in GitHub Secrets', detail: 'For SSO, admin roles, anything that cannot be self-created.' },
    { value: 'derived', label: 'QA signs itself up', detail: 'Passwords derived from one seed secret. Nothing is stored anywhere.' },
  ];
  answers.qa_auth.mode = await choose('Does the app need a login?', authOptions,
    { fallback: pick(authOptions, was('qa_auth.mode'), 0) });

  if (answers.qa_auth.mode !== 'none') {
    note('Two roles let QA prove one user cannot see another\'s data — the highest-value test there is.');
    const roles = (await ask('Role names, comma separated',
      csv(was('qa_auth.roles', null)) || csv((was('qa_auth.accounts', []) ?? []).map((a) => a.role)) || 'primary,secondary'))
      .split(',').map((s) => s.trim()).filter(Boolean);
    if (answers.qa_auth.mode === 'secrets') {
      // Only the names sdlc-qa.yml passes to QA can reach it: a workflow cannot name a secret
      // at run time, and handing it every secret would give them to the job running PR code.
      // setup used to invent QA_<ROLE>_<FIELD> names, which QA then reported as "not set".
      answers.qa_auth.accounts = [{ role: roles[0], fields: { email: 'QA_USER_EMAIL', password: 'QA_USER_PASSWORD' } }];
      if (roles.length > 1) {
        note(`Only "${roles[0]}" can come from secrets: the QA workflow passes exactly QA_USER_EMAIL`);
        note(`and QA_USER_PASSWORD. For ${roles.slice(1).join(', ')}, re-run and choose "QA signs itself up",`);
        note('which derives every role\'s password from QA_FIXTURE_SEED.');
      }
    } else if (answers.qa_auth.mode === 'derived') {
      answers.qa_auth.roles = roles;
    } else {
      answers.qa_auth.accounts = [];
      for (const role of roles) {
        const fields = (await ask(`  fields for "${role}"`, 'email,password',
          { hint: 'e.g. email,password — or phone,otp if that is how this app logs in' }))
          .split(',').map((s) => s.trim()).filter(Boolean);
        // Fixture values are plain text the seed script already contains; fill them in by hand.
        answers.qa_auth.accounts.push({ role, fields: Object.fromEntries(fields.map((f) => [f, ''])) });
      }
    }
  }
}

// --- 6. gates -----------------------------------------------------------------
heading('Human gates');
note('Approving a bad plan costs an implementation, a CI run and a QA cycle, and produces a');
note('PR that looks finished. Rejecting a good one costs a replan. Keep these on at first.');
answers.gates = {
  plan_approval: await confirm('Approve each plan before code is written?', was('gates.plan_approval', true)),
  merge_approval: await confirm('Approve each merge after QA passes?', was('gates.merge_approval', true)),
};
answers.gates.plan_review_agent = answers.gates.plan_approval
  ? true
  : await confirm('Have an agent review plans instead of nobody?', was('gates.plan_review_agent', true));

// --- 7. models ----------------------------------------------------------------
// A gateway serving open-weight models needs a model it serves named for EVERY step: an empty
// one runs the action's default Claude model, and a Claude id is "model not found" — both fail
// at the first request, and read like an outage. setup could not write a provider at all, so a
// provider repo meant hand-editing a generated file. --provider/--model answer it unattended.
heading('Where the models come from');
note('Blank = Anthropic direct on your Claude subscription (CLAUDE_CODE_OAUTH_TOKEN).');
note('A gateway URL = every step runs on a model that gateway serves (ANTHROPIC_API_KEY).');
answers.provider = {
  base_url: await ask('Model gateway base URL, without /v1 (blank = Anthropic direct)',
    arg('provider') ?? was('runtime.provider.base_url', '')),
};
if (answers.provider.base_url) {
  answers.model = await ask('A model it serves, for every step', arg('model') ?? '');
  answers.routerModel = await ask('A cheaper one for the router (blank = the same)', arg('router-model') ?? '');
  if (!answers.model) note(C.yellow('No model named: each step must name one before it can run (doctor lists them).'));
}

// --- write --------------------------------------------------------------------
heading('Writing configuration');
mkdirSync(join(root, '.sdlc'), { recursive: true });
if (existing) {
  // Merged, not rendered: only what was asked changes. The file's comments do not survive a
  // parse and dump; its values all do, which is the part that was being lost.
  writeFileSync(cfgFile, '# Updated by `sdlc setup --force`: only the answered keys changed.\n' +
    dump(mergeAnswers(existing, answers), { lineWidth: 100 }));
  say(`  ${C.green('✓')} .sdlc/config.yml updated — everything setup did not ask about was kept`);
} else {
  writeFileSync(cfgFile, renderConfig(answers, found, forbiddenFor({ files })));
  say(`  ${C.green('✓')} .sdlc/config.yml`);
}

say('');
say(`${C.bold('Next')} — these cannot be done from a config file:`);
say('');
say(`  ${C.cyan('1.')} node bin/sdlc init        ${C.dim('# labels and the state branch')}`);
if (answers.provider.base_url) {
  // A gateway takes the key it issued, as x-api-key; it refuses a Claude OAuth token.
  say(`  ${C.cyan('2.')} gh secret set ANTHROPIC_API_KEY --app actions`);
  say(`     ${C.dim(`the key ${answers.provider.base_url} issued you — not CLAUDE_CODE_OAUTH_TOKEN`)}`);
} else {
  say(`  ${C.cyan('2.')} gh secret set CLAUDE_CODE_OAUTH_TOKEN --app actions`);
  say(`     ${C.dim('reuse an existing token — `claude setup-token` REVOKES the previous one')}`);
}
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
/** A model for every step: the gateway's when there is one, the Anthropic defaults otherwise. */
function modelsFor(a) {
  return Object.fromEntries(ROLES.map((r) => [r, a.provider.base_url
    ? (r === 'router' && a.routerModel) || a.model || ''
    : DIRECT_MODELS[r] ?? '']));
}

/**
 * The existing config with only the answered keys changed. Models are filled in only for steps
 * the provider could not serve as they stand, so a model someone chose per step survives.
 */
function mergeAnswers(cfg, a) {
  const c = structuredClone(cfg);
  c.allowlist = a.allowlist;
  c.base_branch = a.base_branch;
  c.verify = { ...c.verify, mode: a.verifyMode, required_checks: a.required_checks };
  c.env = { ...c.env, ...a.env };
  c.qa_auth = { ...c.qa_auth, ...a.qa_auth };
  c.gates = { ...c.gates, ...a.gates };
  c.runtime = { ...c.runtime, provider: { headers: {}, ...c.runtime?.provider, base_url: a.provider.base_url } };
  c.runtime.model = { ...c.runtime.model };
  const wanted = modelsFor(a);
  for (const r of ROLES) if (a.provider.base_url && a.model && providerProblem(c, r)) c.runtime.model[r] = wanted[r];
  return c;
}

function renderConfig(a, d, forbidden) {
  const list = (arr, indent = '    ') => (arr?.length ? arr.map((x) => `${indent}- "${x}"`).join('\n') : `${indent}[]`);
  const envBlock = a.envMode === 'none'
    ? '  mode: none   # nothing runnable to drive'
    : a.envMode === 'preview'
      ? [`  mode: preview`, `  url_allowlist:`, list(a.env.url_allowlist),
         `  # Hosts the page may SEND DATA to. Empty = QA refuses to run, because a preview`,
         `  # that serves only a frontend commonly inherits the PRODUCTION api url.`,
         `  api_allowlist:`, list(a.env.api_allowlist), `  ready: "${a.env.ready}"`,
         `  audit_url: "${a.env.audit_url ?? ''}"   # an audit (no PR, so no preview) and the debugger drive this`].join('\n')
      : [`  mode: compose`, `  base_url: "${a.env.base_url}"`,
         `  url_allowlist:`, list(a.env.url_allowlist), `  api_allowlist:`, list(a.env.api_allowlist),
         `  ready: "${a.env.ready}"`, `  ready_timeout_seconds: ${a.env.ready_timeout_seconds ?? 0}`,
         `  audit_url: ""   # preview mode only; compose audits drive base_url`,
         // A blank boot as `|` plus an empty indented line is not YAML at all: the whole file
         // failed to parse, at the first workflow step rather than here.
         ...(a.env.boot ? [`  boot: |`, ...a.env.boot.split('\n').map((l) => `    ${l}`)] : ['  boot: ""'])].join('\n');

  const authBlock = a.qa_auth.mode === 'none'
    ? '  mode: none'
    : a.qa_auth.mode === 'derived'
    ? ['  mode: derived', `  roles: [${a.qa_auth.roles.join(', ')}]`, '  scope: pr',
       '  email_domain: qa.invalid   # RFC 2606 reserved: can never reach a real person',
       '  signup_url: "/signup"      # CHECK THIS against the app before the first QA run'].join('\n')
    : [`  mode: ${a.qa_auth.mode}`, '  accounts:',
       ...a.qa_auth.accounts.flatMap((acc) => [
         `    - role: ${acc.role}`,
         `      fields: { ${Object.entries(acc.fields).map(([k, v]) => `${k}: ${v ? v : '""'}`).join(', ')} }`,
       ])].join('\n');

  return `# Written by \`sdlc setup\` from your answers and a scan of this repo.
# Detected: ${d.stack}${d.framework ? ` (${d.framework})` : ''}, ${d.size ?? '?'} files.

runtime:
  # Where the models come from. Empty base_url = Anthropic direct. A gateway is given WITHOUT
  # /v1 (the client appends /v1/messages), authenticates with ANTHROPIC_API_KEY, and every step
  # below must name a model it serves.
  provider:
    base_url: ${q(a.provider.base_url)}
    headers: {}         # e.g. { x-opencode-session: "sdlc-{run}" }
    # Models this gateway serves only on the OpenAI API (e.g. glm-5.3-flash, kimi-k2.7-code on
    # OpenCode Go). Claude Code speaks only Anthropic Messages, so a job running one starts a local
    # LiteLLM translator; "sdlc doctor --live --bridge <m> --agent" proves a model works through it.
    openai_models: []
  # One line per step, every step. Empty = the action's default, which is a Claude model.
  # Opus where a mistake is hardest to recover from (the diagnosis every later stage inherits,
  # the last read before code is trusted, the stack decided once); the router runs on every
  # issue the free rules miss, so it is never Opus.
  model:
${ROLES.map((r) => `    ${`${r}:`.padEnd(20)}${q(modelsFor(a)[r])}`).join('\n')}

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
  lock_ttl_minutes: 300    # must exceed the longest job, or the watchdog reclaims a lock
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

# Numbered section by section for the project planner, whose brief must account for every one.
# Files, or directories of .md; when none exists, the project issue itself is the spec.
spec:
  paths: ["docs/spec", "SPEC.md"]

# How merge-pr merges a PR that passed QA: squash, merge or rebase (gh pr merge --<method>).
release:
  merge_method: squash
`;
  function q(v) { return v ? `"${String(v).replace(/"/g, '\\"')}"` : '""'; }
}
