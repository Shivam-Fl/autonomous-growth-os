#!/usr/bin/env node
// What an agent step actually did — and the artifact it was asked for, when it put it in its
// reply instead of a file.
//
// growth-os #20: the council's arbiter ran 22 turns, reported success, and wrote neither
// work-order.json nor stop.json. The action hides the agent's output from the log, so triage could
// not tell a Write that was refused from one never made, and the plan attempt was lost.
//
// The agent's job reduces the transcript to a summary with jq (transcript-summary.jq) and hands
// it over with the plan; this runs in the job that validates the plan, from a fresh checkout. It
// prints METADATA only — tool calls, each Write's path and whether it failed, how the last turn
// ended — never the reply. And when none of the expected files exists but the reply carries a
// JSON object shaped like one, it is written out: the same agent's output, held to the same
// validator and gates a file would be.
//
//   node .sdlc/bin/agent-transcript.mjs <summary.json> [--recover work-order.json[,stop.json]]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// What a recovered object must have: the schemas' required keys.
const SHAPES = {
  'work-order.json': ['issue', 'version', 'understanding', 'approach', 'files', 'acceptance'],
  'stop.json': ['kind', 'reason'],
};

/** The last JSON object in a reply that has every key `keys` names, or null. */
export function objectIn(text, keys) {
  const t = String(text ?? '');
  const candidates = [...t.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(t.slice(first, last + 1));
  for (const c of candidates.reverse()) {
    try {
      const o = JSON.parse(c);
      if (o && typeof o === 'object' && !Array.isArray(o) && keys.every((k) => k in o)) return o;
    } catch { /* not this one */ }
  }
  return null;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const file = process.argv[2];
  const i = process.argv.indexOf('--recover');
  const wanted = i > 0 ? String(process.argv[i + 1] ?? '').split(',').filter(Boolean) : [];
  let s = null;
  try { s = JSON.parse(readFileSync(file, 'utf8')); } catch { /* none */ }
  if (!s) {
    process.stdout.write(`no transcript summary at ${file || '(none given)'} — nothing to report\n`);
    process.exit(0);
  }
  process.stdout.write(`tools: ${Object.entries(s.tools ?? {}).map(([k, v]) => `${k}×${v}`).join(', ') || 'none'}\n`);
  for (const w of s.writes ?? []) process.stdout.write(`${w.tool} ${w.path} (${w.bytes} chars)${w.error ? ` — FAILED: ${w.error}` : ''}\n`);
  process.stdout.write(`last turn ended: ${s.stop ?? 'unknown'} · final reply ${String(s.reply ?? '').length} chars · result ${JSON.stringify(s.result ?? null)}\n`);
  if (wanted.length && !wanted.some((f) => existsSync(f))) {
    for (const f of wanted) {
      const o = SHAPES[f] ? objectIn(s.reply, SHAPES[f]) : null;
      if (!o) continue;
      writeFileSync(f, `${JSON.stringify(o, null, 2)}\n`);
      process.stdout.write(`::warning::the agent wrote no ${wanted.join(' or ')}, but its reply held a ${f} — recovered from the reply; it is validated like any other\n`);
      break;
    }
  }
}
