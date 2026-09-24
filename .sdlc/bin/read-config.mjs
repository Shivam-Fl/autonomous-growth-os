#!/usr/bin/env node
// Reads a dotted key out of .sdlc/config.yml. Lets workflow steps be config-driven
// instead of hardcoding commands that may not exist in a given project.
//   node .sdlc/bin/read-config.mjs verify.lint
import { loadConfig } from './lib/actions.js';

const key = process.argv[2];
if (!key) { process.stderr.write('usage: read-config <dotted.key>\n'); process.exit(1); }

const value = key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), await loadConfig());
if (value === undefined || value === null) process.exit(0);        // absent = empty = skip
process.stdout.write(Array.isArray(value) ? value.join('\n') : String(value));
