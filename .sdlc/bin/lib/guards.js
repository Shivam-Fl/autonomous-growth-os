// Two hard safety boundaries, kept as pure functions so they can be tested adversarially.
//
// 1. isAllowedUrl  — stops QA opening a browser against anything but a preview.
// 2. findForbidden — stops an agent editing paths a human reserved for itself.
//
// Both FAIL CLOSED: malformed input, empty config, anything unparseable is a refusal.
// The dangerous failure mode for a guard is not a false alarm, it is a quiet yes.

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
