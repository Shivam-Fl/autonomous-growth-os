// The model router (TR-12, spec §17): every model call in the system passes
// through ModelRouter, and no business logic ever names a model. Providers
// are injected at construction; a swap is a constructor argument change
// (IAC-5), never an edit to callers. Each call carries its tenant, task
// type, prompt version and tool-catalog version, and returns the call
// record — provider, model, tokens, latency, integer cost micros — the
// ledger records for the auditor (TR-23). High-impact calls route to a
// second provider with critic: true.

export const ROUTER_ERROR_CODES = Object.freeze({
  UNKNOWN_PROVIDER: 'ROUTER_UNKNOWN_PROVIDER',
  BUDGET_EXCEEDED: 'ROUTER_BUDGET_EXCEEDED',
  TIMEOUT: 'ROUTER_TIMEOUT',
});

export function routerError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

/** A conservative fixed output budget the pre-call estimate uses: a caller
 * that cannot afford the input plus this slack is out of budget up front. */
const ESTIMATED_OUTPUT_TOKENS = 64;

// Rough token estimate: four characters of JSON per token. Deterministic
// though not exact — enough for the pre-call budget gate.
function tokensEstimate(text) {
  return Math.ceil(String(text ?? '').length / 4) + 1;
}

/** Call a provider under a timeout; the timer is cleared either way so a
 * resolved call leaves no dangling rejection. */
function withTimeout(promise, timeoutMs) {
  if (!timeoutMs) {
    return promise;
  }
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(routerError(
      ROUTER_ERROR_CODES.TIMEOUT,
      `model call exceeded the ${timeoutMs}ms timeout`,
      { timeout_ms: timeoutMs },
    )), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The routers' one construction point: providers arrive as an array in
 * priority order (the first is the default, the second the critic), each
 * implementing { id, model, generate_structured, embed }. Business logic
 * passes promptVersion/toolCatalogVersion per call — this module never
 * hardcodes them and never names a model.
 */
export class ModelRouter {
  constructor({ providers, defaultProvider = null } = {}) {
    if (!Array.isArray(providers) || providers.length === 0) {
      throw routerError(ROUTER_ERROR_CODES.UNKNOWN_PROVIDER, 'ModelRouter needs at least one provider', { providers: providers?.length ?? 0 });
    }
    for (const provider of providers) {
      if (!provider || typeof provider.id !== 'string' || typeof provider.model !== 'string'
        || typeof provider.generate_structured !== 'function' || typeof provider.embed !== 'function') {
        throw routerError(ROUTER_ERROR_CODES.UNKNOWN_PROVIDER, 'provider does not implement the model interface', { provider: provider?.id ?? null });
      }
    }
    const ids = providers.map((provider) => provider.id);
    if (new Set(ids).size !== ids.length) {
      throw routerError(ROUTER_ERROR_CODES.UNKNOWN_PROVIDER, 'provider ids must be unique', { ids });
    }
    if (defaultProvider !== null && !ids.includes(defaultProvider)) {
      throw routerError(ROUTER_ERROR_CODES.UNKNOWN_PROVIDER, `default provider ${JSON.stringify(defaultProvider)} is not registered`, { ids });
    }
    this.providers = providers;
    this.defaultProvider = defaultProvider ?? providers[0].id;
  }

  /** Resolve which provider the call goes to. An explicit provider id wins;
   * critic:true routes to the second provider (falling back only when the
   * constructor received exactly one). */
  #resolveProvider({ provider = null, critic = false } = {}) {
    const requested = provider ?? (critic ? this.providers[1]?.id ?? this.defaultProvider : this.defaultProvider);
    const found = this.providers.find((candidate) => candidate.id === requested);
    if (!found) {
      throw routerError(ROUTER_ERROR_CODES.UNKNOWN_PROVIDER, `no provider named ${JSON.stringify(requested)}`, { received: requested, ids: this.providers.map((entry) => entry.id) });
    }
    return found;
  }

  /**
   * The single model-call entry. Args: taskType, schema, messages, tools,
   * budget, timeout, promptVersion, toolCatalogVersion, tenantId, critic,
   * provider. Returns {ok, data, call} and throws
   * ROUTER_UNKNOWN_PROVIDER | ROUTER_BUDGET_EXCEEDED | ROUTER_TIMEOUT.
   */
  async generate_structured({
    taskType,
    schema = null,
    messages = [],
    tools = null,
    budget = null,
    timeout = null,
    promptVersion = null,
    toolCatalogVersion = null,
    tenantId = null,
    critic = false,
    provider: providerId = null,
  } = {}) {
    const provider = this.#resolveProvider({ provider: providerId, critic });

    // The budget gate runs before any provider is touched: an over-budget
    // call is refused up front, never half-flown.
    const tokensInEstimate = tokensEstimate(JSON.stringify(messages ?? []));
    if (budget !== null && tokensInEstimate + ESTIMATED_OUTPUT_TOKENS > budget) {
      throw routerError(
        ROUTER_ERROR_CODES.BUDGET_EXCEEDED,
        `estimated ${tokensInEstimate + ESTIMATED_OUTPUT_TOKENS} tokens exceeds the budget of ${budget}`,
        { estimated: tokensInEstimate + ESTIMATED_OUTPUT_TOKENS, budget },
      );
    }

    const startedAt = Date.now();
    const result = await withTimeout(
      provider.generate_structured({ taskType, schema, messages, tools }),
      timeout,
    );
    const latencyMs = Math.max(0, Date.now() - startedAt);
    return {
      ok: true,
      data: result.data,
      call: {
        provider: provider.id,
        model: provider.model,
        promptVersion: promptVersion ?? null,
        toolCatalogVersion: toolCatalogVersion ?? null,
        taskType: taskType ?? null,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        latencyMs,
        costMicros: provider.priceMicros({ tokensIn: result.tokensIn, tokensOut: result.tokensOut }),
        tenantId: tenantId ?? null,
        occurredAt: new Date().toISOString(),
      },
    };
  }

  /** Embedding hint (TR-10): retrieval assistance only, routed through the
   * same provider abstraction. The structured gate always runs after. */
  async embed({ text, tenantId = null } = {}) {
    const provider = this.#resolveProvider({});
    const startedAt = Date.now();
    const result = await withTimeout(provider.embed({ text }), null);
    const latencyMs = Math.max(0, Date.now() - startedAt);
    return {
      ok: true,
      vector: result.vector,
      call: {
        provider: provider.id,
        model: provider.model,
        taskType: 'embed',
        tokensIn: result.tokensIn,
        tokensOut: 0,
        latencyMs,
        costMicros: provider.priceMicros({ tokensIn: result.tokensIn, tokensOut: 0 }),
        tenantId: tenantId ?? null,
        occurredAt: new Date().toISOString(),
      },
    };
  }
}

/**
 * Fake primary model: deterministic outputs, no network, token counts
 * derived from the input so the call record is testable. A `hang` model
 * never resolves, so the router's timeout path is exercisable in tests.
 */
export class FakePrimaryModel {
  constructor() {
    this.id = 'fake-primary';
    this.model = 'fake-primary-v1';
    this.pricing = { inputMicrosPerToken: 2, outputMicrosPerToken: 8 };
  }

  priceMicros({ tokensIn, tokensOut }) {
    return tokensIn * this.pricing.inputMicrosPerToken + tokensOut * this.pricing.outputMicrosPerToken;
  }

  async generate_structured({ taskType = 'unknown', messages = [] } = {}) {
    const tokensIn = tokensEstimate(JSON.stringify(messages));
    const data = {
      task_type: taskType,
      provider: this.id,
      output: `fake-primary:${taskType}`,
    };
    const tokensOut = tokensEstimate(JSON.stringify(data));
    return { data, tokensIn, tokensOut };
  }

  async embed({ text = '' } = {}) {
    return {
      tokensIn: tokensEstimate(text),
      vector: embedVector(text),
    };
  }
}

/**
 * Fake secondary model: the independent critic leg on a "second provider".
 * Same interface, different id, model and pricing so a swap is observable.
 */
export class FakeSecondaryModel {
  constructor() {
    this.id = 'fake-secondary';
    this.model = 'fake-secondary-v1';
    this.pricing = { inputMicrosPerToken: 5, outputMicrosPerToken: 12 };
  }

  priceMicros({ tokensIn, tokensOut }) {
    return tokensIn * this.pricing.inputMicrosPerToken + tokensOut * this.pricing.outputMicrosPerToken;
  }

  async generate_structured({ taskType = 'unknown', messages = [] } = {}) {
    const tokensIn = tokensEstimate(JSON.stringify(messages));
    const data = {
      task_type: taskType,
      provider: this.id,
      output: `fake-secondary:${taskType}`,
    };
    const tokensOut = tokensEstimate(JSON.stringify(data));
    return { data, tokensIn, tokensOut };
  }

  async embed({ text = '' } = {}) {
    return {
      tokensIn: tokensEstimate(text),
      vector: embedVector(text),
    };
  }
}

/**
 * A hanging provider for the timeout test: generate_structured never
 * resolves, so only the router's OWN timeout resolves.
 */
export class HangingModel {
  constructor() {
    this.id = 'hanging';
    this.model = 'hanging-v1';
  }

  priceMicros() {
    return 0;
  }

  generate_structured() {
    return new Promise(() => {});
  }

  embed() {
    return new Promise(() => {});
  }
}

/** Deterministic 8-dim embedding vector: character counts bucketed by
 * code-unit modulo. Good enough to rank text near text; never a real
 * model's vector, and never asserted as one. */
function embedVector(text) {
  const vector = new Array(8).fill(0);
  const normalized = String(text ?? '').toLowerCase();
  for (const char of normalized) {
    vector[char.charCodeAt(0) % 8] += 1;
  }
  const total = normalized.length || 1;
  return vector.map((count) => count / total);
}
