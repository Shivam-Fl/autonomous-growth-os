#!/usr/bin/env node
// The `settings` JSON that points Claude Code at a model provider.
//
// `runtime.model.<stage>` already chooses a model per step. What it could not do is choose a
// PROVIDER: the base URL, the key and any headers that provider demands live outside the
// model name, and hardcoding them in fourteen workflows is fourteen places to get wrong.
//
// Empty config means the default Anthropic endpoint and the action's own OAuth token, which
// is what every repo had before this existed — so a repo that sets nothing behaves exactly
// as it did.
//
// Header names matter more than they look. OpenCode Go rejects `Authorization: Bearer` with
// "Missing API key" and requires `x-api-key`, which is what ANTHROPIC_API_KEY sends and
// ANTHROPIC_AUTH_TOKEN does not. It also requires `x-opencode-session` on every request and
// answers a missing one with an opaque 500 on its Anthropic endpoint — a 400 wearing the
// wrong number, which costs an hour if you assume the model is down.

import { loadConfig, setOutput } from './lib/actions.js';

const cfg = await loadConfig();
const p = cfg.runtime?.provider ?? {};

const env = {};
// The client appends `/v1/messages` itself, so a base URL that already ends in /v1 becomes
// `.../v1/v1/messages` — a 404 that Claude Code reports as
// "model_not_found: It may not exist or you may not have access to it", which reads as a
// missing model and sends you looking at the catalog instead of the path.
if (p.base_url) env.ANTHROPIC_BASE_URL = String(p.base_url).replace(/\/+$/, '').replace(/\/v1$/, '');

// A stable id per conversation, which for this pipeline is one workflow run. Providers use
// it for routing and prompt caching; one shared constant would pool every issue's context.
if (p.headers && typeof p.headers === 'object') {
  const run = process.env.GITHUB_RUN_ID ?? String(Date.now());
  env.ANTHROPIC_CUSTOM_HEADERS = Object.entries(p.headers)
    .map(([k, v]) => `${k}: ${String(v).replace('{run}', run)}`)
    .join('\n');
}

// Emitted BOTH ways on purpose.
//
// `settings.env` is what the action documents, and it does not reach the CLI process: a run
// logged `INPUT_SETTINGS` carrying the base URL and, three lines later, `ANTHROPIC_BASE_URL:`
// empty. The agent then ran `--model kimi-k3` against Anthropic's own endpoint, which
// rejected it in 0.7 seconds with `is_error` and no message — which reads exactly like a
// model that cannot cope, and is nothing of the kind.
//
// So the workflow also sets them as real step env, which is the thing that actually works.
setOutput('settings', JSON.stringify(Object.keys(env).length ? { env } : {}));
setOutput('base_url', env.ANTHROPIC_BASE_URL ?? '');
setOutput('headers', env.ANTHROPIC_CUSTOM_HEADERS ?? '');
setOutput('uses_provider', p.base_url ? 'true' : 'false');
