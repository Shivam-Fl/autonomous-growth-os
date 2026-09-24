#!/usr/bin/env node
// Asserts the QA target is a preview, not production. Runs BEFORE any browser opens.
//
// `--for debug` holds the debugger's target to debug_env.url_allowlist instead, which may reach
// further than QA's on purpose (a bug often exists only where it was reported); empty means the
// same as QA's, as config.yml says.
import { isAllowedUrl } from './lib/guards.js';
import { loadConfig, flags, die } from './lib/actions.js';

const { url, for: role } = flags();
const cfg = await loadConfig();
const debug = role === 'debug';
const own = debug ? cfg.debug_env?.url_allowlist ?? [] : [];
const result = isAllowedUrl(url, own.length ? own : cfg.env?.url_allowlist);

if (!result.ok) {
  die(`refusing to run ${debug ? 'the debugger' : 'QA'} against "${url}": ${result.reason}` +
      (debug && own.length ? ' (debug_env.url_allowlist)' : '') +
      '\nThis guard exists so an agent trying to break things never points at production.');
}
process.stdout.write('target ok: ' + result.host + '\n');
