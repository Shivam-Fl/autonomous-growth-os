#!/usr/bin/env node
// Checks a CLAUDE_CODE_OAUTH_TOKEN without ever printing it.
//
//   export CLAUDE_CODE_OAUTH_TOKEN='...'   (quotes matter)
//   node .sdlc/bin/verify-token.mjs
//
// Separates the three things that all surface as the same unhelpful 401:
//   1. the value carries whitespace or line breaks from copying
//   2. the value is shaped wrong (not an oat token at all)
//   3. the value is clean and correctly shaped, but the server rejects it
//      — revoked, expired, or issued by an account without an active subscription
//
// Only (3) means "get a new token". (1) and (2) mean "the copy is wrong", and they are by
// far the more common cause, because the token is long enough to wrap in a normal terminal.

import { spawn } from 'node:child_process';

const raw = process.env.CLAUDE_CODE_OAUTH_TOKEN;

if (!raw) {
  console.error('CLAUDE_CODE_OAUTH_TOKEN is not set in this shell.\n');
  console.error("  export CLAUDE_CODE_OAUTH_TOKEN='sk-ant-oat01-...'");
  console.error('\nUse single quotes. Without them the shell can mangle the value.');
  process.exit(1);
}

// --- 1. shape, without revealing the value ---------------------------------
const trimmed = raw.trim();
const problems = [];

if (raw !== trimmed) problems.push('has leading or trailing whitespace');
if (/\s/.test(trimmed)) {
  const newlines = (trimmed.match(/\n/g) ?? []).length;
  const spaces = (trimmed.match(/[ \t]/g) ?? []).length;
  problems.push(
    `contains whitespace INSIDE the value (${newlines} newline(s), ${spaces} space/tab(s)) — ` +
    'this is what happens when a wrapped token is selected with the mouse',
  );
}
if (!trimmed.startsWith('sk-ant-oat')) {
  problems.push(`does not start with "sk-ant-oat" (starts "${trimmed.slice(0, 10)}…")`);
}

console.log('Token shape');
console.log(`  length:      ${raw.length} chars (${trimmed.length} after trim)`);
console.log(`  first/last:  ${trimmed.slice(0, 12)}…${trimmed.slice(-4)}`);
console.log(`  one line:    ${!/\s/.test(trimmed) ? 'yes' : 'NO'}`);

if (problems.length) {
  console.log('\n✗ The value itself is malformed:');
  for (const p of problems) console.log(`  - ${p}`);
  console.log('\nFix the copy before blaming the token. Widen the terminal so it prints on one');
  console.log('line, or select it with keyboard rather than mouse.');
  process.exit(1);
}
console.log('  → shape is clean\n');

// --- 2. does the server accept it? -----------------------------------------
console.log('Asking Claude to answer with this token…');

const child = spawn('claude', ['-p', 'reply with exactly: OK'], {
  env: {
    ...process.env,
    CLAUDE_CODE_OAUTH_TOKEN: trimmed,
    ANTHROPIC_API_KEY: '',           // force the OAuth path, not a stray local key
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
let err = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { err += d; });

child.on('close', (code) => {
  const combined = out + err;
  if (code === 0 && /ok/i.test(out)) {
    console.log('\n✓ The token works.');
    console.log('\nSo if GitHub Actions still returns 401, the secret does not hold this exact');
    console.log('value. Re-set it interactively and paste at the prompt:');
    console.log('  gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo <owner>/<repo>');
    process.exit(0);
  }

  console.log('\n✗ The server rejected it.\n');
  const detail = combined.trim().split('\n').slice(0, 6).join('\n');
  if (detail) console.log(detail + '\n');

  if (/401|invalid|unauthor/i.test(combined)) {
    console.log('The value is well-formed but not accepted. Usually one of:');
    console.log('  - a NEWER `claude setup-token` run revoked this one. Only the most recently');
    console.log('    issued token is valid, so if you generated several, older ones are dead.');
    console.log('  - the account that issued it has no active Claude subscription.');
    console.log('\nGenerate one more, and this time set the secret from that same run without');
    console.log('generating another afterwards.');
  }
  process.exit(1);
});

child.on('error', () => {
  console.log('\n✗ Could not run `claude` — is the CLI on your PATH?');
  process.exit(1);
});
