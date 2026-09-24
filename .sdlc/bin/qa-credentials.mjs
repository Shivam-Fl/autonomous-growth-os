#!/usr/bin/env node
// Produces the credentials QA uses, without ever storing a password anywhere.
//
// The obvious designs are both wrong:
//   - QA signs up and saves the credentials for reuse -> saved WHERE? memory/ and the ledger
//     are both git. That puts a working password in the repository, permanently.
//   - QA signs up fresh every run and discards -> no reuse, and the database fills with
//     orphaned accounts nobody cleans up.
//
// So: DERIVE them. One seed secret lives in GitHub Secrets; every account's password is an
// HMAC of that seed and a stable identity. Nothing is stored, the same identity always yields
// the same password (so accounts are reusable across runs), and the seed can be rotated in
// one place. A leaked derived password compromises one throwaway test account, not the seed.

import { createHmac } from 'node:crypto';
import { loadConfig, setOutput, die } from './lib/actions.js';

const cfg = await loadConfig();
const auth = cfg.qa_auth ?? {};
const mode = auth.mode ?? 'none';

if (mode === 'none') {
  setOutput('mode', 'none');
  process.stdout.write('qa_auth.mode is "none" — QA will test unauthenticated flows only\n');
  process.exit(0);
}

if (mode === 'secrets') {
  // Named secrets, one set per role. Shapes differ between roles: a customer may log in by
  // phone and OTP while an owner uses a password.
  // Accounts that cannot be self-created: SSO, admin roles, anything provisioned by hand.
  // The values arrive as env from GitHub Secrets; this step only reports which are present
  // so a missing one fails here rather than as a confusing login timeout mid-run.
  const declared = auth.accounts ?? [{ role: 'primary', fields: { email: 'QA_USER_EMAIL', password: 'QA_USER_PASSWORD' } }];
  const names = declared.flatMap((a) => Object.values(a.fields ?? {}));
  // sdlc-qa.yml hands this step exactly these. YAML cannot name a secret at run time, and
  // passing toJSON(secrets) would give every secret to the job that runs the PR's code — so any
  // other name can never arrive, however it is set. setup used to generate QA_<ROLE>_<FIELD>
  // names, and the step then reported them "not set" while the owner could see them set.
  const PASSED = ['QA_USER_EMAIL', 'QA_USER_PASSWORD'];
  const unpassed = names.filter((n) => !PASSED.includes(n));
  if (unpassed.length) {
    die(`qa_auth.accounts names ${unpassed.join(', ')}, which sdlc-qa.yml never passes to QA — ` +
        `it passes exactly ${PASSED.join(' and ')}.\n` +
        '  Store the account in those two secrets. For a second role, use qa_auth.mode "derived" ' +
        '(QA signs up as each role, passwords derived from QA_FIXTURE_SEED).');
  }
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    die(`qa_auth.mode is "secrets" but these are not set: ${missing.join(', ')}\n` +
        `  gh secret set ${missing[0]} --app actions --repo <owner>/<repo>`);
  }
  const accounts = declared.map((a) => ({
    role: a.role,
    ...Object.fromEntries(Object.entries(a.fields ?? {}).map(([k, secret]) => [k, process.env[secret]])),
  }));
  for (const a of accounts) {
    for (const [k, v] of Object.entries(a)) {
      if (k !== 'role' && v) process.stdout.write(`::add-mask::${v}\n`);
    }
  }
  setOutput('mode', 'secrets');
  setOutput('accounts', JSON.stringify(accounts));
  process.stdout.write(`credentials for ${accounts.length} role(s) from secrets: ${declared.map((a) => a.role).join(', ')}\n`);
  process.exit(0);
}

if (mode === 'fixture') {
  // Credentials written in plain text in config. Legitimate ONLY for an environment created
  // empty and destroyed with the runner — a seeded compose stack, where the "password" is a
  // constant the seed script already contains and protecting it would be theatre.
  //
  // The danger is drift: someone later flips env.mode to preview, and now plaintext
  // credentials are pointed at a real system. So the mode verifies its own preconditions
  // rather than trusting that whoever set it knew what it meant.
  const env = cfg.env ?? {};
  const reasons = [];
  if (env.mode !== 'compose') {
    reasons.push(`env.mode is "${env.mode}", not "compose" — fixture credentials are only for a stack built from scratch each run`);
  }
  const hosts = env.api_allowlist ?? [];
  if (!hosts.length) {
    reasons.push('env.api_allowlist is empty, so the environment cannot be shown to be local');
  }
  const nonLocal = hosts.filter((h) => !/^localhost(:|$)|^127\.0\.0\.1(:|$)/.test(String(h)));
  if (nonLocal.length) {
    reasons.push(`env.api_allowlist permits ${nonLocal.join(', ')}, which is not local — data would leave the runner`);
  }
  if (reasons.length) {
    die('qa_auth.mode is "fixture" but this environment is not ephemeral:\n' +
        reasons.map((r) => `  - ${r}`).join('\n') +
        '\nPlaintext credentials must never point at a real system. Use mode "secrets" instead.');
  }

  const accounts = (auth.accounts ?? []).map((a) => ({ role: a.role, ...a.fields }));
  if (!accounts.length) die('qa_auth.mode is "fixture" but no accounts are declared');

  setOutput('mode', 'fixture');
  setOutput('accounts', JSON.stringify(accounts));
  process.stdout.write(
    `fixture credentials for ${accounts.length} role(s): ${accounts.map((a) => a.role).join(', ')}\n` +
    'Plaintext by design — this database is created empty and destroyed with the runner.\n');
  process.exit(0);
}

if (mode !== 'derived') die(`unknown qa_auth.mode "${mode}" — expected none, fixture, secrets or derived`);

const seed = process.env.QA_FIXTURE_SEED;
if (!seed) {
  die('qa_auth.mode is "derived" but QA_FIXTURE_SEED is not set.\n' +
      '  Generate one and store it once:\n' +
      '    gh secret set QA_FIXTURE_SEED --repo <owner>/<repo>   # paste any long random string\n' +
      '  Every QA password is derived from it, so nothing else needs storing.');
}

// Scope decides reuse. "run" gives a fresh account per QA run — no state carried between
// runs, at the cost of a new row each time. "pr" reuses one account across a PR's retries,
// which is usually what you want: the fix loop re-runs QA and a stable login is one less
// variable. "global" reuses one account forever, for an app where signup is expensive.
const scope = auth.scope ?? 'pr';
const pr = process.env.PR ?? '0';
const run = process.env.GITHUB_RUN_ID ?? '0';
const key = { run: `run-${run}`, pr: `pr-${pr}`, global: 'global' }[scope] ?? `pr-${pr}`;

const roles = auth.roles ?? ['primary'];
const domain = auth.email_domain ?? 'qa.invalid';   // RFC 2606: guaranteed never deliverable

const accounts = roles.map((role) => {
  const identity = `${key}:${role}`;
  // Separate HMAC contexts so the password can never equal any other derived value.
  const password = createHmac('sha256', seed).update(`password:${identity}`).digest('base64url').slice(0, 24) + 'aA1!';
  return {
    role,
    email: `qa-${identity.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}@${domain}`,
    password,
  };
});

// Masked in the log so a password never appears in a workflow run anyone can read.
for (const a of accounts) process.stdout.write(`::add-mask::${a.password}\n`);

setOutput('mode', 'derived');
setOutput('scope', scope);
setOutput('accounts', JSON.stringify(accounts));
setOutput('signup_url', auth.signup_url ?? '');

process.stdout.write(
  `derived ${accounts.length} account(s), scope=${scope}:\n` +
  accounts.map((a) => `  ${a.role}: ${a.email}`).join('\n') + '\n' +
  'Passwords are derived from QA_FIXTURE_SEED and are not stored anywhere.\n',
);
