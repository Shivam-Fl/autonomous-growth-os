// Two hard safety boundaries, kept as pure functions so they can be tested adversarially.
//
// 1. isAllowedUrl  — stops QA opening a browser against anything but a preview.
// 2. findForbidden — stops an agent editing paths a human reserved for itself.
//
// Both FAIL CLOSED: malformed input, empty config, anything unparseable is a refusal.
// The dangerous failure mode for a guard is not a false alarm, it is a quiet yes.

import { RESERVED, PROTECTED_DOCS } from './detect.js';

/**
 * Host-based allowlist check for the QA target URL.
 *
 * Matching is on the parsed HOST only — never on the raw string — because every classic
 * bypass (`https://ok.example.com@evil.com`, `https://evil.com/?x=ok.example.com`) works by
 * putting the allowed text somewhere that is not the host.
 *
 * Patterns: `*.vercel.app` (subdomains only, dot-anchored), `localhost:*` (any port),
 * `pr-*.example.com`, or an exact `host` / `host:port`.
 *
 * @returns {{ok: true, host: string} | {ok: false, reason: string}}
 */
export function isAllowedUrl(rawUrl, allowlist = []) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { ok: false, reason: 'no URL supplied' };
  }
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    return { ok: false, reason: 'env.url_allowlist is empty — refusing to open any browser target' };
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `"${rawUrl}" is not a parseable URL` };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `refusing protocol "${url.protocol}"` };
  }
  // Credentials in a URL are the standard way to make a host look like another host.
  if (url.username || url.password) {
    return { ok: false, reason: 'URL contains embedded credentials' };
  }

  const host = url.hostname.toLowerCase();              // no port
  const hostPort = url.port ? `${host}:${url.port}` : host;

  for (const rawPattern of allowlist) {
    const pattern = String(rawPattern).trim().toLowerCase();
    if (!pattern) continue;
    if (matchesHost(pattern, host, hostPort)) return { ok: true, host: hostPort };
  }
  return { ok: false, reason: `host "${hostPort}" is not in env.url_allowlist` };
}

function matchesHost(pattern, host, hostPort) {
  // "localhost:*" / "host:*" — any port on that exact host
  if (pattern.endsWith(':*')) return host === pattern.slice(0, -2);

  // "*.example.com" — a subdomain, dot-anchored so "evil-example.com" cannot match.
  // Deliberately does NOT match the apex: production is usually the apex.
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1);                     // ".example.com"
    return host.endsWith(suffix) && host.length > suffix.length;
  }

  // "pr-*.example.com" — a single wildcard label
  if (pattern.includes('*')) {
    const re = new RegExp(
      '^' + pattern.split('*').map((s) => s.replace(/[.+^${}()|[\]\\?]/g, '\\$&')).join('[^.]*') + '$',
    );
    return re.test(host) || re.test(hostPort);
  }

  return host === pattern || hostPort === pattern;
}

/**
 * Which backends did the page actually talk to, and are they all allowed?
 *
 * Checking the page URL alone is not enough and can be actively misleading. A preview
 * deployment often serves only a frontend while inheriting the production API base URL, so
 * the page passes a `*.vercel.app` allowlist while every write lands in the production
 * database. The guard has to look at where the data goes, not where the HTML came from.
 *
 * @param {string[]} requestUrls every request origin the page made, from the HAR
 * @param {string[]} allowlist   host patterns the API is permitted to be
 * @returns {{ok: true, origins: string[]} | {ok: false, reason: string, offending: string[]}}
 */
export function checkApiOrigins(requestUrls = [], allowlist = []) {
  if (!allowlist.length) {
    return { ok: false, reason: 'env.api_allowlist is empty — cannot prove this is not production' };
  }
  const origins = new Set();
  for (const u of requestUrls) {
    try {
      const { protocol, hostname, port } = new URL(u);
      if (protocol !== 'http:' && protocol !== 'https:') continue;
      origins.add(port ? `${hostname}:${port}` : hostname);
    } catch { /* not a URL we can judge */ }
  }
  const offending = [...origins].filter(
    (host) => !allowlist.some((p) => matchesHost(String(p).trim().toLowerCase(), host.split(':')[0], host)),
  );
  return offending.length
    ? { ok: false, reason: `the page called ${offending.join(', ')}, which env.api_allowlist does not permit`, offending }
    : { ok: true, origins: [...origins] };
}

/**
 * The rules one change is judged against: the framework's own reserved paths UNION the config's
 * forbidden_paths (config can add, never remove), plus what depends on whose branch it is.
 *
 * - The approved spec and architecture change only on the project planner's sdlc/project-*
 *   branch, whose PR always waits for a human.
 * - The rest of .sdlc/memory/ changes only on the Librarian's memory/* branch, whose PR a
 *   person reviews — or, with merge approval off, merge-memory-prs merges only when these same
 *   rules pass. Anywhere else it is an auto-merged ticket rewriting what later agents read.
 */
export function reservedRules(cfg = {}, headRef = '') {
  const project = String(headRef).startsWith('sdlc/project-');
  const memory = String(headRef).startsWith('memory/');
  return [
    ...RESERVED,
    ...(Array.isArray(cfg.forbidden_paths) ? cfg.forbidden_paths : []),
    ...(project ? [] : PROTECTED_DOCS),
    ...(project || memory ? [] : ['.sdlc/memory/**']),
  ];
}

/** A test file, by the naming the JS/TS runners share. */
export const isTestFile = (path) => /(^|\/)[^/]+\.(test|spec)\.[^/]+$/.test(String(path));

/** A line that turns a test off, or turns every other test off. */
export const SKIPS = /\.(skip|only)\(|\bx(it|describe)\(/;

/**
 * What `npm ci` and `npm install` run on their own, named by nothing. ci-verify's Bootstrap
 * installs the head, so a `postinstall` the PR adds runs before any check does, and can rewrite
 * the framework on the runner (outside the diff) so that every check reads "not configured".
 */
const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare'];

/**
 * The package.json scripts that decide "green": every script a verify.* command runs, followed
 * through the bodies of those scripts, plus every sdlc: verb — and the hooks npm runs around
 * them without being asked: the install hooks, and pre<name> and post<name> of each (`npm test`
 * runs `pretest` first, which can swap the runner in node_modules/.bin). Read from the BASE
 * package.json, because the head is the party being judged — and from the head as well, by
 * reservedChanges, only to reach what a script the head fills in calls.
 */
export function gatingScripts(verify = {}, scripts = {}) {
  const invoked = (cmd) => [
    ...[...String(cmd).matchAll(/\bnpm\s+(?:run(?:-script)?|rum|urn)\s+(?:--\S+\s+)*([^\s;&|'"]+)/g)].map((m) => m[1]),
    ...[...String(cmd).matchAll(/\b(?:yarn|pnpm)\s+run\s+([^\s;&|'"]+)/g)].map((m) => m[1]),
    ...(/\bnpm\s+(?:test|t|tst)\b/.test(String(cmd)) ? ['test'] : []),
  ];
  const queue = [
    ...Object.keys(scripts).filter((k) => k.startsWith('sdlc:')),
    ...Object.values(verify).filter((v) => typeof v === 'string').flatMap(invoked),
  ];
  const found = new Set();
  while (queue.length) {
    const name = queue.shift();
    if (found.has(name)) continue;
    found.add(name);
    if (typeof scripts[name] === 'string') queue.push(...invoked(scripts[name]));
  }
  return [...new Set([...found, ...INSTALL_HOOKS, ...[...found].flatMap((n) => [`pre${n}`, `post${n}`])])];
}

/**
 * Every reason a branch's change needs a person, beyond the paths it touches.
 *
 * @param {{path: string, from?: string, status: 'A'|'M'|'D'|'R'}[]} changes  both sides of a rename
 * @param {Record<string, string[]>} added  lines each changed test file adds
 * @param {{base: object, head: object}|null} pkg  root package.json scripts, when it changed
 */
export function reservedChanges({ changes = [], cfg = {}, headRef = '', added = {}, pkg = null }) {
  const rules = reservedRules(cfg, headRef);
  const hits = [];
  for (const c of changes) {
    // A rename is a deletion of its old path: moving a guarded file away removes it as surely
    // as deleting it, and git reports only the new name unless asked for both.
    const hit = findForbidden([c.from, c.path].filter(Boolean), rules)[0];
    if (hit) hits.push(c.from && hit.path === c.from ? { ...hit, path: `${c.from} -> ${c.path}` } : hit);
    else if (c.status === 'D' && isTestFile(c.path)) hits.push({ path: c.path, rule: 'deletes a test file' });
    else {
      const skip = (added[c.path] ?? []).find((l) => SKIPS.test(l));
      if (skip && isTestFile(c.path)) hits.push({ path: c.path, rule: `turns tests off: ${skip.trim().slice(0, 80)}` });
    }
  }
  // What "green" means lives in package.json scripts the PR under test can edit: point
  // sdlc:verify at `echo ok` and CI passes by definition.
  //
  // But a verb the brief stubbed (`sdlc:seed: exit 0` until there is a database) and a script a
  // verb calls that does not exist yet (`npm test` before anything defines `test`) are the first
  // tickets' to fill. Refusing every change to them parked the first greenfield ticket, and
  // `/sdlc approve` re-ran the same change into the same refusal. So filling one in with a real
  // command passes; replacing, removing or stubbing a real one does not. The head's own bodies
  // are followed too, so the `test` a ticket fills cannot call a new `check` that is `exit 0`.
  // ponytail: a real-looking body that verifies nothing (`node -e 0`) passes this rule; review
  // and QA are what catch it.
  if (pkg && !String(headRef).startsWith('sdlc/project-')) {
    const base = pkg.base ?? {};
    const head = pkg.head ?? {};
    const gating = new Set([...gatingScripts(cfg.verify ?? {}, base), ...gatingScripts(cfg.verify ?? {}, head)]);
    // A hook is never a stub waiting to be filled: nothing needs one, and adding one is how code
    // runs before the checks that judge it.
    const hooks = new Set(INSTALL_HOOKS);
    for (const n of gating) hooks.add(`pre${n}`).add(`post${n}`);
    for (const name of gating) {
      if (base[name] === head[name]) continue;
      if (hooks.has(name)) {
        hits.push({ path: 'package.json', rule: `changes "${name}", which npm runs on its own around what verify runs` });
        continue;
      }
      const fills = (base[name] === undefined || isTrivialScript(base[name])) && typeof head[name] === 'string' && !isTrivialScript(head[name]);
      if (!fills) hits.push({ path: 'package.json', rule: `changes the "${name}" script verify runs` });
    }
  }
  return hits;
}

/** A script that does nothing: every `&&`, `||` or `;` segment is `exit 0`, `true`, `:` or an echo. */
export const isTrivialScript = (body) => String(body).split(/&&|\|\||;/)
  .every((s) => /^\s*(exit(\s+0)?|true|:|echo(\s.*)?)?\s*$/.test(s));

/**
 * Which of these paths are reserved from agents?
 * Globs: `**` crosses directories, `*` does not.
 * @returns {{path: string, rule: string}[]} empty when nothing is forbidden
 */
export function findForbidden(paths = [], forbidden = []) {
  const hits = [];
  for (const path of paths) {
    const normalised = String(path).replace(/^\.\//, '').replace(/\\/g, '/');
    for (const rule of forbidden) {
      if (globMatch(String(rule), normalised)) {
        hits.push({ path, rule });
        break;
      }
    }
  }
  return hits;
}

function globMatch(glob, path) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;   // "**/" also matches zero directories
      } else {
        re += '[^/]*';
      }
    } else if ('.+^${}()|[]\\?'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$').test(path);
}
