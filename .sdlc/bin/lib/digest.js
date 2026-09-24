// Turns a raw CI log into the handful of lines that explain the failure.
//
// No model involved — this is regex, and it runs on every red build. Feeding a 10k-line log
// to an agent costs real money and buries the signal; feeding it twenty lines costs nothing
// and works better. The digest is also what a human reads first, so it is written for a
// person, not just for the next prompt.

const MAX_FINDINGS = 20;

const MATCHERS = [
  {
    tool: 'typescript',
    // src/auth/session.ts(44,12): error TS2532: Object is possibly 'undefined'.
    re: /^(?<file>[^\s(]+)\((?<line>\d+),(?<col>\d+)\):\s+error\s+(?<code>TS\d+):\s+(?<message>.+)$/,
  },
  {
    tool: 'typescript',
    // src/auth/session.ts:44:12 - error TS2532: ...
    re: /^(?<file>[^\s:]+):(?<line>\d+):(?<col>\d+)\s+-\s+error\s+(?<code>TS\d+):\s+(?<message>.+)$/,
  },
  {
    tool: 'eslint',
    // /abs/path/file.ts
    //   44:12  error  'x' is defined but never used  no-unused-vars
    re: /^\s+(?<line>\d+):(?<col>\d+)\s+error\s+(?<message>.+?)\s\s+(?<code>[\w-/@]+)$/,
    needsFileContext: true,
  },
  {
    tool: 'node-test',
    re: /^not ok \d+ - (?<message>.+)$/,
  },
  {
    tool: 'jest',
    // ● Auth › session persists on reload
    re: /^\s*●\s+(?<message>.+)$/,
  },
];

// A bare path on its own line establishes file context for eslint-style output.
const FILE_HEADER = /^(?:\/|\.\/|[A-Za-z]:\\)?[\w./\\@-]+\.(?:[jt]sx?|mjs|cjs|vue|svelte)$/;

// Lines that are noise in every log.
const NOISE = /^(npm (WARN|notice)|\s*at\s|warning|Downloading|Progress|\s*\d+\s*\|)/i;

/**
 * @param {string} log raw CI output
 * @returns {{tool: string|null, findings: object[], summary: string, truncated: boolean, lines_scanned: number}}
 */
export function digest(log) {
  const lines = String(log ?? '').split(/\r?\n/);
  const findings = [];
  let fileContext = null;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line || NOISE.test(line)) continue;

    if (FILE_HEADER.test(line.trim())) {
      fileContext = line.trim();
      continue;
    }

    for (const m of MATCHERS) {
      const hit = line.match(m.re);
      if (!hit) continue;
      const g = hit.groups ?? {};
      if (m.needsFileContext && !fileContext) break;
      findings.push({
        tool: m.tool,
        file: g.file ?? (m.needsFileContext ? fileContext : undefined),
        line: g.line ? Number(g.line) : undefined,
        code: g.code,
        message: (g.message ?? '').trim(),
      });
      break;
    }
    if (findings.length >= MAX_FINDINGS * 2) break; // stop scanning a runaway log
  }

  // Identical errors repeated across a matrix build add nothing.
  const seen = new Set();
  const unique = findings.filter((f) => {
    const key = `${f.tool}|${f.file}|${f.line}|${f.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const truncated = unique.length > MAX_FINDINGS;
  const kept = unique.slice(0, MAX_FINDINGS);
  const tool = kept.length ? kept[0].tool : null;

  return { tool, findings: kept, summary: toMarkdown(kept, truncated), truncated, lines_scanned: lines.length };
}

function toMarkdown(findings, truncated) {
  if (!findings.length) {
    return 'CI failed but no recognised error pattern was found in the log. A human should read the raw output.';
  }
  const byTool = {};
  for (const f of findings) (byTool[f.tool] ??= []).push(f);

  const parts = [];
  for (const [tool, items] of Object.entries(byTool)) {
    parts.push(`**${tool}** — ${items.length} error${items.length > 1 ? 's' : ''}`);
    for (const f of items) {
      const where = f.file ? `\`${f.file}${f.line ? `:${f.line}` : ''}\`` : '';
      const code = f.code ? ` [${f.code}]` : '';
      parts.push(`- ${where}${where ? ' — ' : ''}${f.message}${code}`);
    }
    parts.push('');
  }
  if (truncated) parts.push(`_More errors were found than are shown; fix these first._`);
  return parts.join('\n').trim();
}
