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
import { writeFileSync } from 'node:fs';
import { loadConfig, die } from './lib/actions.js';
import { dump } from './lib/js-yaml.mjs';

export function bridgeConfig(cfg, { models, run = process.env.GITHUB_RUN_ID ?? String(Date.now()) } = {}) {
  const p = cfg.runtime?.provider ?? {};
  if (!p.base_url) throw new Error('runtime.provider.base_url is empty — there is no gateway to bridge to');
  const list = (models ?? p.openai_models ?? []).map((m) => String(m).trim()).filter(Boolean);
  const headers = Object.fromEntries(Object.entries(p.headers ?? {})
    .map(([k, v]) => [k, String(v).replaceAll('{run}', run)]));
  const apiBase = `${String(p.base_url).replace(/\/+$/, '').replace(/\/v1$/, '')}/v1`;
  return {
    model_list: list.map((m) => ({
      model_name: m,
      litellm_params: {
        model: `openai/${m}`,
        api_base: apiBase,
        api_key: 'os.environ/ANTHROPIC_API_KEY',
        ...(Object.keys(headers).length ? { extra_headers: headers } : {}),
      },
    })),
    litellm_settings: {
      // LiteLLM sends /v1/messages for an openai/ model through the Responses API by default,
      // and these models are served on chat/completions only.
      use_chat_completions_url_for_anthropic_messages: true,
      // Claude Code sends Anthropic-only fields (cache_control, thinking budgets, metadata) a
      // chat/completions backend rejects; dropping what the backend does not take is the point.
      drop_params: true,
    },
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const out = process.argv[2] || die('usage: model-bridge.mjs <out.yaml>');
  const models = process.env.BRIDGE ? process.env.BRIDGE.split(',') : undefined;
  const cfg = bridgeConfig(await loadConfig(), { models });
  if (!cfg.model_list.length) die('no models to bridge: set BRIDGE or runtime.provider.openai_models');
  writeFileSync(out, dump(cfg));
  process.stdout.write(`bridging ${cfg.model_list.map((m) => m.model_name).join(', ')} -> ${cfg.model_list[0].litellm_params.api_base}\n`);
}
