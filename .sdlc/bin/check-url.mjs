#!/usr/bin/env node
// Asserts the QA target is a preview, not production. Runs BEFORE any browser opens.
import { isAllowedUrl } from './lib/guards.js';
import { loadConfig, flags, die } from './lib/actions.js';

const { url } = flags();
const cfg = await loadConfig();
const result = isAllowedUrl(url, cfg.env?.url_allowlist);

if (!result.ok) {
  die('refusing to run QA against "' + url + '": ' + result.reason +
      '\nThis guard exists so an agent trying to break things never points at production.');
}
process.stdout.write('target ok: ' + result.host + '\n');
