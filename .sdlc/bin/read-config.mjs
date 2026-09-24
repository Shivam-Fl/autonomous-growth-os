#!/usr/bin/env node
// Reads a dotted key out of .sdlc/config.yml. Lets workflow steps be config-driven
// instead of hardcoding commands that may not exist in a given project.
//   node .sdlc/bin/read-config.mjs verify.lint
import { loadConfig } from './lib/actions.js';

const key = process.argv[2];
if (!key) { process.stderr.write('usage: read-config <dotted.key>\n'); process.exit(1); }

const value = key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), await loadConfig());
if (value === undefined || value === null) process.exit(0);        // absent = empty = skip
// Always ending in a newline. `$(…)` strips it, so every capture is unchanged; but a step that
// writes a multi-line output as `{ echo 'boot<<SDLC_EOF'; read-config env.boot; echo 'SDLC_EOF'; }`
// got `npm run sdlc:serveSDLC_EOF` on one line, GitHub found no delimiter, and the implement job
// died on its second step on the first issue it ever ran.
const out = Array.isArray(value) ? value.join('\n') : String(value);
process.stdout.write(out.endsWith('\n') ? out : `${out}\n`);
