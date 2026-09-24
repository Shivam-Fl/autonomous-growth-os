#!/usr/bin/env node
// Polls the preview until it answers, so QA never reports a deploy race as a product bug.
import { loadConfig, flags, die } from './lib/actions.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { isTrivialScript } from './lib/guards.js';

const { url } = flags();
const cfg = await loadConfig();
// compose mode can be slow: docker pull, migrate, seed, then two dev servers compiling.
// A default that fits a static site fails a real app for the wrong reason.
//
// `0` is the sentinel meaning "auto", and `??` does not catch it: the config `sdlc install`
// writes says `ready_timeout_seconds: 0   # 0 = auto` in its own comment, and that zero was
// passed straight through as a real timeout. The deadline was then already in the past, the
// loop below never ran once, and QA reported "never became ready after 0s (last: no
// response)" about an app whose boot log plainly said `listening on 127.0.0.1:3000`. The
// file that documents a sentinel and the file that reads it have to agree about it.
const configured = Number(flags().timeout ?? cfg.env?.ready_timeout_seconds ?? 0);
const timeout = configured > 0 ? configured : (cfg.env?.mode === 'compose' ? 420 : 180);
// The app's own readiness check wins when it has one. The architecture brief decides it
// (`sdlc:ready`: `curl -f http://localhost:3000/health`), and this polled env.ready — "/", which
// a FastAPI app answers with 404 — so QA would have waited out the whole timeout on an app that
// was up. A stub sdlc:ready is not a check, so it falls back to the configured path.
const appDir = process.env.APP_DIR || '.';
const pkgPath = join(appDir, 'package.json');
const readyScript = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')).scripts?.['sdlc:ready'] : undefined;
if (typeof readyScript === 'string' && !isTrivialScript(readyScript)) {
  const deadline = Date.now() + timeout * 1000;
  let last = '';
  do {
    const r = await new Promise((res) => execFile('npm', ['run', '-s', 'sdlc:ready'], { cwd: appDir, timeout: 20_000 },
      (e, stdout, stderr) => res({ ok: !e, out: String(stderr || stdout || e?.message || '').trim() })));
    if (r.ok) { process.stdout.write(`ready: sdlc:ready passed (${readyScript})\n`); process.exit(0); }
    last = r.out.split('\n').pop();
    await new Promise((r2) => setTimeout(r2, 3000));
  } while (Date.now() < deadline);
  die(`app never became ready: sdlc:ready (${readyScript}) kept failing for ${timeout}s (last: ${last}).` +
    '\nThis is an environment failure, not a product defect — QA is blocked, not failed.');
}
const readyPath = cfg.env?.ready ?? '/';
const target = new URL(readyPath, url).toString();
const deadline = Date.now() + Number(timeout) * 1000;

let lastStatus = 'no response';
// do/while, so a timeout that resolves to something absurd still costs the app one honest
// attempt. Reporting "not ready" without ever having asked is the failure mode above, and it
// reads exactly like a broken app rather than like a broken poller.
do {
  try {
    const res = await fetch(target, { redirect: 'follow' });
    if (res.ok) {
      process.stdout.write('ready: ' + target + ' -> ' + res.status + '\n');
      process.exit(0);
    }
    lastStatus = String(res.status);
  } catch (e) {
    lastStatus = e.message;
  }
  await new Promise((r) => setTimeout(r, 3000));
} while (Date.now() < deadline);
die('app never became ready at ' + target + ' after ' + timeout + 's (last: ' + lastStatus + ').' +
    '\nThis is an environment failure, not a product defect — QA is blocked, not failed.' +
    '\nIn compose mode check the boot logs, and raise env.ready_timeout_seconds if the stack is simply slow.');
