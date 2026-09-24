#!/usr/bin/env node
// Polls the preview until it answers, so QA never reports a deploy race as a product bug.
import { loadConfig, flags, die } from './lib/actions.js';

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
