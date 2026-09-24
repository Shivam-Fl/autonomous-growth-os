#!/usr/bin/env node
// Checks that the framework's one dependency loads from where the framework keeps it.
//
// This used to INSTALL js-yaml, `--no-save`, into the repo root — the product's node_modules.
// Anything that ran `npm ci` or `npm install` there afterwards pruned it as extraneous. QA
// installs the app to boot it, so after twenty minutes of a passing browser run the merge
// step died with ERR_MODULE_NOT_FOUND, and so did the failure handler meant to report it,
// because it needed the same package from the same place. A handler that shares a failure
// mode with what it handles is not one, and re-running this before each handler only moved
// the race.
//
// So js-yaml is vendored at lib/js-yaml.mjs and every config reader imports it by relative
// path: nothing an agent runs in the product tree can remove it, and this never runs npm. It
// stays a step so the workflows calling it keep working, and so a damaged vendored copy fails
// here, by name, rather than inside the first script that reads config.
try {
  await import('./lib/js-yaml.mjs');
  process.stdout.write('js-yaml vendored\n');
} catch (e) {
  process.stderr.write(`sdlc: the vendored js-yaml at .sdlc/bin/lib/js-yaml.mjs does not load: ${e.message}\n`);
  process.exit(1);
}
