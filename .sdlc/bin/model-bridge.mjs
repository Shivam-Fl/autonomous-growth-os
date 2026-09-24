#!/usr/bin/env node
// Writes the LiteLLM config that lets Claude Code call a model the gateway serves only on the
// OpenAI API.
//
// Every agent step is Claude Code, which speaks the Anthropic Messages API and nothing else.
// OpenCode Go serves GLM, Kimi K2.x, LongCat, MiMo and Hy3 only on /v1/chat/completions: probed
// on /v1/messages they answer 503 "Endpoint is unavailable", although they are the cheapest
// strong models in its $60 pools. A local translator in front of them is the one way in, and
// LiteLLM is the maintained headless one — this writes its config, the workflow runs it.
//
//   node .sdlc/bin/model-bridge.mjs <out.yaml>        models from BRIDGE (comma-separated),
//                                                     else runtime.provider.openai_models
//
// The key is never written: LiteLLM reads it from ANTHROPIC_API_KEY itself (os.environ/…).
import { writeFileSync, openSync, mkdtempSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, die } from './lib/actions.js';
import { dump } from './lib/js-yaml.mjs';

export const LITELLM = 'litellm[proxy]==1.102.1';
export const BRIDGE_PORT = 4000;

/** Is any of these models served only on the OpenAI API? Then the job needs the translator. */
export function needsBridge(cfg, models) {
  const openai = new Set((cfg.runtime?.provider?.openai_models ?? []).map(String));
  return Boolean(cfg.runtime?.provider?.base_url) && models.some((m) => openai.has(String(m)));
}

export function bridgeConfig(cfg, { models, openai: openaiGiven, api = 'chat', run = process.env.GITHUB_RUN_ID ?? String(Date.now()) } = {}) {
  const p = cfg.runtime?.provider ?? {};
  if (!p.base_url) throw new Error('runtime.provider.base_url is empty — there is no gateway to bridge to');
  const list = [...new Set((models ?? p.openai_models ?? []).map((m) => String(m).trim()).filter(Boolean))];
  // A job runs every agent step against ONE base URL, so once the translator is up every model
  // the job uses goes through it: the OpenAI-only ones translated, the rest passed straight to
  // the gateway's own Messages API. With no openai_models list (the probe's --bridge), every
  // model given is treated as OpenAI-only.
  const openai = new Set((openaiGiven ?? (p.openai_models?.length ? p.openai_models : list)).map(String));
  const gateway = String(p.base_url).replace(/\/+$/, '').replace(/\/v1$/, '');
  const headers = Object.fromEntries(Object.entries(p.headers ?? {})
    .map(([k, v]) => [k, String(v).replaceAll('{run}', run)]));
  return {
    model_list: list.map((m) => ({
      model_name: m,
      litellm_params: {
        model: openai.has(m) ? `openai/${m}` : `anthropic/${m}`,
        api_base: openai.has(m) ? `${gateway}/v1` : gateway,
        api_key: 'os.environ/ANTHROPIC_API_KEY',
        ...(Object.keys(headers).length ? { extra_headers: headers } : {}),
      },
    })),
    litellm_settings: {
      // LiteLLM sends /v1/messages for an openai/ model through the Responses API by default,
      // and most of these models are served on chat/completions only. `api: 'responses'` is for
      // the ones OpenCode serves on /responses instead (Muse Spark).
      ...(api === 'responses' ? {} : { use_chat_completions_url_for_anthropic_messages: true }),
      // Claude Code sends Anthropic-only fields (cache_control, thinking budgets, metadata) a
      // chat/completions backend rejects; dropping what the backend does not take is the point.
      drop_params: true,
    },
  };
}

/**
 * Install and start the translator for this job, and return the base URL Claude Code should use.
 * Detached, so it outlives the step that started it and serves every later step of the job; the
 * runner reaps it when the job ends. Its key comes from this process's ANTHROPIC_API_KEY.
 */
export async function startBridge(cfg, models, { dir = process.env.RUNNER_TEMP || mkdtempSync(join(tmpdir(), 'bridge-')) } = {}) {
  const venv = join(dir, 'litellm');
  execFileSync('python3', ['-m', 'venv', venv], { stdio: 'inherit' });
  execFileSync(join(venv, 'bin/pip'), ['install', '-q', LITELLM], { stdio: 'inherit' });
  const conf = join(dir, 'litellm.yaml');
  writeFileSync(conf, dump(bridgeConfig(cfg, { models })));
  const log = openSync(join(dir, 'litellm.log'), 'a');
  spawn(join(venv, 'bin/litellm'), ['--config', conf, '--host', '127.0.0.1', '--port', String(BRIDGE_PORT)],
    { detached: true, stdio: ['ignore', log, log] }).unref();
  const url = `http://127.0.0.1:${BRIDGE_PORT}`;
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${url}/health/liveliness`)).ok) return url; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`the model translator never came up — see ${join(dir, 'litellm.log')}`);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const out = process.argv[2] || die('usage: model-bridge.mjs <out.yaml>');
  const models = process.env.BRIDGE ? process.env.BRIDGE.split(',').map((m) => m.trim()).filter(Boolean) : undefined;
  // Models named explicitly (the probe's --bridge) are the ones being translated, whatever the
  // configured list says: treating them as native sent them to /v1/messages, which answered 503.
  const cfg = bridgeConfig(await loadConfig(), { models, openai: models, api: process.env.BRIDGE_API || 'chat' });
  if (!cfg.model_list.length) die('no models to bridge: set BRIDGE or runtime.provider.openai_models');
  writeFileSync(out, dump(cfg));
  process.stdout.write(`bridging ${cfg.model_list.map((m) => m.model_name).join(', ')} -> ${cfg.model_list[0].litellm_params.api_base}\n`);
}
