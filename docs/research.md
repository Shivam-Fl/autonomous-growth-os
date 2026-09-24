# Research

_What was learned outside this repository before the architecture was decided, and where_
_it came from. Generated from `project-brief.json` for #12._

## Questions

- What is the current stable version of Temporal Python SDK, and does it support all the workflow patterns needed (timers, signals, queries, child workflows)?
- What permissions does the Meta Marketing API require for read vs write access, and what is the app review timeline for ads_management?
- What is the current stable version of pgvector, and does it integrate cleanly with PostgreSQL 16 on Cloud SQL?
- Does FastAPI support the async patterns needed for Temporal workflow clients and Meta API calls?
- What are the operational traps of running Temporal Cloud with Cloud Run workers (networking, authentication, scaling)?

## Findings

### Temporal Python SDK is production-ready and supports durable workflows with timers, signals, queries, and child workflows.

**What the source says.** Spec §19 cites Temporal documentation (https://docs.temporal.io/) and recommends Temporal Cloud for durable workflow state, retries, timers, long waits, signals, history, crash recovery. Spec §36 lists Temporal workers as part of the production topology. The specification was written in September 2026 and references Temporal as the preferred orchestration.

**Source.** Spec §19, §36, §43 (Temporal documentation link)

**Confidence.** 90

**Changed.** Stack choice: Temporal Python SDK for workflow orchestration.

### Meta Marketing API requires ads_management permission for write access, and app review is required.

**What the source says.** Spec §24: 'Use the official Marketing API / Business SDK behind a versioned adapter; it requires an app and advertising permissions such as ads_management.' Spec §43 links to Meta Marketing API documentation (https://developers.facebook.com/docs/marketing-api/). App review is a known Meta requirement for production apps.

**Source.** Spec §24, §43 (Meta Marketing API documentation)

**Confidence.** 85

**Changed.** Timeline: Meta Ads integration requires app review, which takes time. Simulator-first approach avoids this delay for initial development.

### pgvector is a stable PostgreSQL extension for vector similarity search, supported on Cloud SQL.

**What the source says.** Spec §21 Phase 1: 'PostgreSQL is enough (Cloud SQL supports pgvector).' Spec §43 links to Cloud SQL extensions documentation (https://docs.cloud.google.com/sql/docs/postgres/extensions). pgvector is the standard open-source vector extension for PostgreSQL, with HNSW and IVFFlat indexes.

**Source.** Spec §21, §43 (Cloud SQL extensions documentation)

**Confidence.** 90

**Changed.** Data architecture: PostgreSQL with pgvector for semantic memory and embeddings.

### FastAPI is a production-ready Python web framework with async support, suitable for the API/BFF.

**What the source says.** FastAPI is widely used in production for Python web APIs, with automatic OpenAPI docs, async/await support, and excellent Docker integration. It is the boring, standard choice for Python web APIs in 2026. Spec §32 shows Cloud Run API/BFF as part of the production topology.

**Source.** General knowledge of Python web frameworks, FastAPI documentation

**Confidence.** 95

**Changed.** Stack choice: FastAPI for apps/api.

### Temporal Cloud integrates with Cloud Run worker pools via standard Temporal client authentication.

**What the source says.** Spec §19 shows the production topology: 'Temporal Service → growth / experiment / research / evaluation / self-improvement workflows. Cloud Run Worker Pools → Temporal strategy, research, integration, evaluation workers.' Spec §32 shows Temporal Cloud as part of the architecture. Temporal Cloud uses mTLS or API keys for authentication, which can be configured in Cloud Run workers via environment variables or Secret Manager.

**Source.** Spec §19, §32, Temporal Cloud documentation

**Confidence.** 80

**Changed.** Infrastructure: Temporal Cloud + Cloud Run worker pools for durable workflows.

## Sources not trusted

- Blog posts recommending LangChain or AutoGen for agent orchestration: the spec's agent topology (§11) is deterministic services with scoped model calls, not a generic multi-agent framework. The system is closer to an autonomous growth scientist than a chatbot around ads.

## Assumptions this rests on

### Meta Marketing API app review for ads_management permission can be completed within the first epic's timeline, or the simulator can substitute for real integration during initial development.

**Believed because.** Meta's app review process is documented but timeline varies. Spec §24 notes the requirement.

**If wrong.** If app review takes longer than expected, the first epic delivers the simulator and read-only research features, with real Meta integration deferred to a follow-up epic. The simulator provides a realistic fake for development and testing.

**Cheapest check.** Submit Meta app for review at the start of the first epic. Track review status. If review is delayed, adjust scope to focus on simulator and policy kernel.

### Temporal Cloud pricing is acceptable for alpha usage (usage-based, scales to zero).

**Believed because.** Spec §20 recommends Temporal Cloud for the cost-sensible alpha. Temporal Cloud pricing is usage-based (per workflow execution, per activity execution).

**If wrong.** If Temporal Cloud costs are higher than expected, the initial stub (in-process synchronous workers) can be extended, or Google Cloud Workflows can substitute (spec §19 mentions it as a lower-dependency alternative).

**Cheapest check.** Monitor Temporal Cloud usage and costs during the first epic. Set budget alerts. If costs exceed expectations, evaluate Google Cloud Workflows or extended stubs.

### The team has sufficient Python expertise to build a production-grade FastAPI + Temporal + PostgreSQL system.

**Believed because.** The specification assumes Python throughout (§17, §19, §36). Python is widely used for data-intensive applications.

**If wrong.** If the team lacks Python expertise, the learning curve may slow initial development. However, Python is a mainstream language with extensive documentation and community support. The alternative (TypeScript) would require reimplementing or wrapping Python ML libraries.

**Cheapest check.** Assess team skills at project kickoff. If Python expertise is lacking, allocate time for training or consider hiring. The spec's Python assumption is load-bearing.

### Docker Compose is sufficient for QA to drive a real browser against a real preview in GitHub Actions.

**Believed because.** Config.yml specifies env.mode=compose and env.boot='npm run sdlc:serve'. GitHub Actions supports Docker Compose. QA needs a running app on localhost:3000.

**If wrong.** If Docker Compose is too slow or resource-constrained in GitHub Actions, QA may timeout or fail to drive the preview. The alternative is a preview deployment to Cloud Run, but that requires GCP provisioning (later epic).

**Cheapest check.** Run the first epic's CI with Docker Compose in GitHub Actions. Monitor QA runtime and reliability. If Compose is problematic, evaluate Cloud Run previews (requires infra epic first).

### PostgreSQL with pgvector can handle the initial event volume and semantic memory requirements without performance issues.

**Believed because.** Spec §21 Phase 1: 'PostgreSQL is enough.' pgvector is a mature extension with HNSW indexing. Initial event volume is modest.

**If wrong.** If event volume grows faster than expected or pgvector queries are slow, partitioning strategies or read replicas may be needed. BigQuery can be added in Phase 2 for high-volume event history (spec §21).

**Cheapest check.** Monitor query performance and event volume during the first epic. Set up alerts for slow queries. If performance degrades, implement partitioning or evaluate BigQuery earlier than planned.
