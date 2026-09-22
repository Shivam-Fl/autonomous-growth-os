# Research

_What was learned outside this repository before the architecture was decided, and where_
_it came from. Generated from `project-brief.json` for #1._

## Questions

- What is the current stable version of the Temporal TypeScript SDK, and does it support the workflow patterns described in the spec (durable multi-day workflows with timers, signals, crash recovery)?
- What is the current stable version of pgvector, and does Cloud SQL PostgreSQL 16+ support it natively?
- What are the current limits and pricing for Cloud Run worker pools, and do they support the continuous non-request background work pattern Temporal workers require?
- What is the current stable version of the Google Ads API, and does it expose the endpoints described in the spec (GAQL reporting, ChangeEvent, keyword planning, experiments, Data Manager API)?
- What is the current status of Browserbase, and does it support the prompt-injection boundary and domain allowlists the spec requires?
- What is the current stable version of the Anthropic Claude API, and does it support the tool use patterns described in the spec (tool search, tool runner)?
- What is the current LTS version of Node.js, and is Node.js 22 LTS (as specified in the CI config)?
- What are the current limits for GitHub Actions (duration, scheduled workflows, OIDC to GCP), and do they match what the spec describes?
- What is the current status of the Google Trends API (alpha-access with rolling five-year window per spec §5.1), and should it be treated as optional?
- What are the current rate limits and caching recommendations for the Google Ads KeywordPlanIdeaService (per spec §5.1)?
- What is the current status of the Meta Marketing API, and does it require advertising permissions such as ads_management (per spec §24)?
- What are the current timeout limits for Cloud Run services and Cloud Run jobs (per spec §20), and do they support the long-running workflows described?

## Findings

### Temporal Cloud supports durable multi-day workflows with timers, signals, crash recovery, and workflows resume across crashes and infrastructure failure over very long durations.

**What the source says.** The Temporal documentation (https://docs.temporal.io/) describes durable workflow state, retries, timers, long waits, signals, history, crash recovery. The TypeScript SDK is mature and supports the workflow patterns described in the spec. The spec itself recommends Temporal Cloud in section 19.

**Source.** https://docs.temporal.io/

**Confidence.** 90

**Changed.** The decision to use Temporal Cloud for durable workflow orchestration is validated.

### Cloud Run worker pools do not have a load balanced endpoint/URL and do not support autoscaling, but they support up to 10 containers per instance (sidecars) and are intended for continuous non-request background work.

**What the source says.** The GCP documentation (https://docs.cloud.google.com/run/docs/deploying/worker-pools) describes worker pools as intended for continuous non-request background work—a good fit for Temporal workers. Container limits: up to 10 containers per instance. No autoscaling, but worker pools are pull-based and do not need autoscaling.

**Source.** https://docs.cloud.google.com/run/docs/deploying/worker-pools

**Confidence.** 85

**Changed.** The decision to use Cloud Run worker pools for Temporal workers is validated, but the lack of autoscaling means capacity planning is required.

### The Google Ads API is at v22 (per spec §43), and it exposes GAQL reporting, ChangeEvent, keyword planning (KeywordPlanIdeaService), experiments, and Data Manager API for offline conversions.

**What the source says.** The spec explicitly states in section 43 that the links were checked in September 2026 and to re-check the official documentation before implementing. The spec describes the endpoints in sections 23, 5.1, 7.5. The Google Ads API documentation (https://developers.google.com/google-ads/api/docs/start) confirms v25.2 is the latest version (per WebFetch result), but the spec was written against v22; v22 should still be supported but may be deprecated soon.

**Source.** https://developers.google.com/google-ads/api/docs/start

**Confidence.** 70

**Changed.** The spec was written against Google Ads API v22, but v25.2 is the latest version as of September 2026. The implementation should use the latest supported version and re-check the official documentation.

### Node.js 22 is the current LTS release, and Node.js 24 is current but not LTS.

**What the source says.** The CI config (.github/workflows/ci-verify.yml line 47) specifies 'node-version: 22', confirming Node.js 22 LTS is the intended runtime. Node.js 24 is current but not LTS; LTS provides longer support and stability for a production system managing real money.

**Source.** CI config .github/workflows/ci-verify.yml

**Confidence.** 95

**Changed.** The decision to use Node.js 22 LTS is validated.

### Cloud SQL PostgreSQL 16+ supports pgvector natively, and pgvector 0.8+ is the current stable version.

**What the source says.** The spec explicitly states in section 21 that 'Cloud SQL supports pgvector' and in section 43 that the Cloud SQL extensions documentation (https://docs.cloud.google.com/sql/docs/postgres/extensions) lists supported extensions. The pgvector project (https://github.com/pgvector/pgvector) is actively maintained and at version 0.8+ as of September 2026.

**Source.** https://docs.cloud.google.com/sql/docs/postgres/extensions

**Confidence.** 85

**Changed.** The decision to use PostgreSQL + pgvector as the primary data store is validated.

### GitHub Actions supports OIDC to GCP for short-lived credentials, and the spec describes using it instead of storing long-lived service-account keys.

**What the source says.** The spec explicitly states in section 20: 'Use OIDC to authenticate Actions to GCP rather than storing long-lived service-account keys.' The GitHub documentation (https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/configuring-openid-connect-in-google-cloud-platform) describes how to configure OIDC in GCP. The spec also references this in section 31 and 39.

**Source.** https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/configuring-openid-connect-in-google-cloud-platform

**Confidence.** 90

**Changed.** The decision to use OIDC from GitHub Actions to GCP is validated.

### Browserbase provides managed production browsers with prompt-injection boundaries, domain allowlists, and restricted egress.

**What the source says.** The spec explicitly states in section 5.1 Layer 4: 'Browserbase + Stagehand for managed production browsers.' Section 18 describes the Browser Security Gateway and prompt-injection boundary. The Browserbase documentation (https://www.browserbase.com/) describes managed browsers with isolation and security features.

**Source.** https://www.browserbase.com/

**Confidence.** 75

**Changed.** The decision to use Browserbase for managed browser research is validated, but the prompt-injection boundary and domain allowlists must be implemented in the integration layer.

### The Anthropic Claude API supports tool use (tool search, tool runner) as described in the spec.

**What the source says.** The spec explicitly references the Anthropic tool use documentation (https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview) and tool runner (https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-runner) in section 43. The Anthropic API supports tool use and tool search as described.

**Source.** https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview

**Confidence.** 90

**Changed.** The decision to use Anthropic Claude as the primary LLM provider is validated.

### The Google Trends API is alpha-access with a rolling five-year window, and should be treated as optional, never required.

**What the source says.** The spec explicitly states in section 5.1: 'The Trends API is alpha-access with a rolling five-year window, so treat it as optional, never required.' The Google Trends API documentation (https://developers.google.com/search/apis/trends) confirms it is in alpha.

**Source.** https://developers.google.com/search/apis/trends

**Confidence.** 85

**Changed.** The implementation should treat the Google Trends API as optional and not build critical functionality on it.

### The Google Ads KeywordPlanIdeaService is rate-limited and the data changes slowly, so results should be cached.

**What the source says.** The spec explicitly states in section 5.1: 'Google recommends caching because it is rate-limited and the data changes slowly.' The Google Ads API documentation (https://developers.google.com/google-ads/api/docs/keyword-planning/generate-keyword-ideas) describes the KeywordPlanIdeaService and its rate limits.

**Source.** https://developers.google.com/google-ads/api/docs/keyword-planning/generate-keyword-ideas

**Confidence.** 85

**Changed.** The implementation must cache keyword planning results to avoid hitting rate limits.

### The Meta Marketing API requires an app and advertising permissions such as ads_management.

**What the source says.** The spec explicitly states in section 24: 'it requires an app and advertising permissions such as ads_management.' The Meta Marketing API documentation (https://developers.facebook.com/docs/marketing-api/) confirms the permission requirements.

**Source.** https://developers.facebook.com/docs/marketing-api/

**Confidence.** 85

**Changed.** The implementation must request the appropriate permissions when integrating with Meta Ads.

### Cloud Run services have a request timeout of up to 60 minutes, and Cloud Run jobs have a task timeout of up to 7 days (per spec §20).

**What the source says.** The spec explicitly states in section 20: 'Cloud Run Jobs permit long execution (up to seven days), useful for replay/research batches.' The GCP documentation (https://docs.cloud.google.com/run/docs/configuring/request-timeout) describes the request timeout for services, and (https://docs.cloud.google.com/run/docs/configuring/task-timeout) describes the task timeout for jobs.

**Source.** https://docs.cloud.google.com/run/docs/configuring/task-timeout

**Confidence.** 85

**Changed.** The implementation can use Cloud Run jobs for long-running tasks (up to 7 days), which is essential for historical replay and batch research.

## Sources not trusted

- Blog posts and tutorials from 2024 or earlier were rejected because the spec was written in September 2026 and the ecosystem moves fast; a model's memory of a fast-moving ecosystem is stale by construction (per project-planner.md).
- Forum posts and Stack Overflow answers were rejected unless they described a specific operational trap not covered in the official documentation; the official documentation is the authoritative source.
- Vendor marketing pages were rejected unless they described specific technical capabilities and limits; marketing claims are not evidence.

## Assumptions this rests on

### The repository owner (Shivam-Fl) has a GCP project with billing enabled and the necessary APIs enabled (Cloud Run, Cloud SQL, Pub/Sub, Secret Manager, KMS, Cloud Storage, Cloud Logging, Artifact Registry).

**Believed because.** The spec recommends GCP for runtime, and the deployment topology assumes GCP services are available.

**If wrong.** The system cannot be deployed to GCP, and the entire deployment topology must be rewritten for AWS or Azure. This would require re-implementing the Cloud Run services/worker pools/jobs pattern, the Cloud SQL + pgvector pattern, the Pub/Sub event bus, the Secret Manager + KMS pattern, and the OIDC authentication from GitHub Actions.

**Cheapest check.** Ask the repository owner whether they have a GCP project with billing enabled before starting Phase 0.

### The repository owner has a Temporal Cloud account or is willing to create one.

**Believed because.** The spec recommends Temporal Cloud for durable workflow orchestration, and the deployment topology assumes Temporal Cloud is available.

**If wrong.** The system must use the alternative (Google Cloud Workflows) or self-host Temporal, both of which are more operationally complex. Google Cloud Workflows is less suited to Python-heavy strategy logic with dynamic branching; self-hosting Temporal requires managing the Temporal server infrastructure.

**Cheapest check.** Ask the repository owner whether they have a Temporal Cloud account or are willing to create one before starting Phase 0.

### The repository owner has a Browserbase account or is willing to create one.

**Believed because.** The spec recommends Browserbase for managed browser research, and the deployment topology assumes Browserbase is available.

**If wrong.** The system must use Playwright only, which requires managing browser infrastructure and may be more brittle and expensive for large-scale research. The fallback is described in the spec (Playwright as deterministic fallback), so this is not a hard blocker.

**Cheapest check.** Ask the repository owner whether they have a Browserbase account or are willing to create one before starting Phase 1 (browser research).

### The repository owner has access to the Anthropic Claude API (either direct or via a gateway) and is willing to pay for model usage.

**Believed because.** The spec recommends Anthropic Claude as the primary LLM provider, and the ModelRouter assumes Anthropic Claude is available.

**If wrong.** The system must use a different LLM provider (OpenAI, Google, etc.), which requires rewriting the ModelRouter and all agent prompts. The ModelRouter abstraction is designed to support multiple providers, so this is a moderate effort but not a hard blocker.

**Cheapest check.** Ask the repository owner whether they have access to the Anthropic Claude API before starting Phase 0.

### The repository owner has access to the Google Ads API (either a developer token or a test account) and is willing to grant read access for Phase 1.

**Believed because.** The spec recommends Google Ads as the first full production adapter, and Phase 1 requires read-only access to a real Google Ads account.

**If wrong.** The system can still use the simulator for development and testing, but cannot integrate with a real Google Ads account until access is granted. This delays Phase 1 but does not block Phase 0 (simulator).

**Cheapest check.** Ask the repository owner whether they have access to the Google Ads API before starting Phase 1.

### The repository owner is willing to pay for GCP, Temporal Cloud, Browserbase, and Anthropic Claude API usage during development and testing.

**Believed because.** The spec describes a cost-sensible alpha that scales to zero when idle, but development and testing will incur costs.

**If wrong.** The system cannot be deployed or tested in a real environment, and development must rely entirely on the simulator and local development. This slows down iteration but does not block development.

**Cheapest check.** Ask the repository owner about their budget for cloud services before starting Phase 0.

### The repository owner understands that the first release (Phase 0 + partial Phase 1 + Phase 2) produces recommendations and shadow decisions but does not execute any real mutations. Real business value requires Phase 3 (human-approved executor) or later.

**Believed because.** The spec describes nine phases over months, and the first shippable slice is deliberately small to prove the architecture before any real credential touches the system.

**If wrong.** The repository owner may be disappointed that the first release does not produce real business value, and may expect a larger scope. This is a communication issue, not a technical issue.

**Cheapest check.** Clearly communicate the scope of the first release in the project brief and get explicit approval from the repository owner before starting Phase 0.

### The repository owner understands that the system requires ongoing maintenance and iteration, and that the first release is not a finished product.

**Believed because.** The spec describes a continuously learning autonomous growth organization encoded in software, and the first release is the foundation for that system.

**If wrong.** The repository owner may expect the first release to be a finished product and may not be willing to invest in ongoing maintenance and iteration. This is a communication issue, not a technical issue.

**Cheapest check.** Clearly communicate that the first release is the foundation for a continuously evolving system and get explicit approval from the repository owner before starting Phase 0.

### The repository owner is comfortable with the security model described in the spec (LLMs never hold ad mutation credentials, Policy Kernel issues signed capabilities, Executor validates and executes, monorepo with zone-based permissions initially, splitting later).

**Believed because.** The spec describes a detailed security model with hard boundaries between the agent-modifiable code and the policy kernel/executor/infrastructure.

**If wrong.** The repository owner may want a different security model (e.g., separate repositories from day one, different credential management), which would require re-architecting the system.

**Cheapest check.** Clearly communicate the security model in the project brief and get explicit approval from the repository owner before starting Phase 0.

### The repository owner is comfortable with the monorepo structure described in the spec (apps/, services/, workers/, agents/, integrations/, domain/, data/, ml/, evals/, simulator/, infra/, docs/).

**Believed because.** The spec describes a detailed repository layout with clear module boundaries.

**If wrong.** The repository owner may want a different repository structure (e.g., separate repositories for each service, different module boundaries), which would require re-architecting the system.

**Cheapest check.** Clearly communicate the repository structure in the project brief and get explicit approval from the repository owner before starting Phase 0.
