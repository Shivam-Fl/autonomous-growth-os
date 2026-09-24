#!/usr/bin/env node
// One real Claude Code session per model: streaming, several turns, tool results sent back.
//
// A ping and one forced tool call prove a model can be reached; they do not prove Claude Code can
// run on it. Every agent step streams, sends tool_result blocks back across turns and expects the
// model to stop on its own — the exact places a translator (or a model) goes wrong. So the probe
// can run the CLI itself on a task with a checkable outcome.
//
//   MODELS=a,b node .sdlc/bin/agent-check.mjs <out.json>     (claude on PATH, ANTHROPIC_* set)
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const exec = promisify(execFile);
const TASK = 'Create a file named answer.txt whose entire content is the number 6 multiplied by 7. ' +
  'Then read answer.txt back with the Read tool, and reply with exactly DONE.';

export async function agentCheck(models, { claude = 'claude', timeoutMs = 300_000 } = {}) {
  const out = [];
  for (const model of models) {
    const dir = mkdtempSync(join(tmpdir(), 'agent-check-'));
    const t0 = Date.now();
    try {
      const { stdout } = await exec(claude, ['-p', TASK, '--model', model, '--allowedTools', 'Write,Read',
        '--output-format', 'json'], { cwd: dir, timeout: timeoutMs, maxBuffer: 16 << 20 });
      let res = {};
      try { res = JSON.parse(stdout); } catch { /* not JSON: judged by the file alone */ }
      const file = existsSync(join(dir, 'answer.txt')) ? readFileSync(join(dir, 'answer.txt'), 'utf8').trim() : null;
      out.push({ model, ok: file === '42', file, turns: res.num_turns ?? null, secs: Math.round((Date.now() - t0) / 1000),
        reply: String(res.result ?? '').slice(0, 200), error: res.is_error ? String(res.result ?? '').slice(0, 300) : null });
    } catch (e) {
      out.push({ model, ok: false, secs: Math.round((Date.now() - t0) / 1000),
        error: String(e.stderr || e.message).replace(/\s+/g, ' ').slice(0, 400) });
    }
  }
  return out;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const models = String(process.env.MODELS ?? '').split(',').map((m) => m.trim()).filter(Boolean);
  const results = await agentCheck(models);
  writeFileSync(process.argv[2] || 'agent.json', `${JSON.stringify(results, null, 2)}\n`);
  for (const r of results) process.stdout.write(`${r.ok ? 'ok  ' : 'FAIL'} ${r.model} ${r.secs}s ${r.turns ?? '?'} turns ${r.error ?? r.reply ?? ''}\n`);
}
