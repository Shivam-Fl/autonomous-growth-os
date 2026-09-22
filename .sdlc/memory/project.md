# Project

Written by the project planner and approved by a human, once, before the first ticket was
planned. Every agent reads this before deciding anything — correct it here rather than
arguing with it in a ticket.

## What this is
Autonomous Growth OS — an autonomous growth-intelligence system that continuously researches markets, manages advertising through a capability-gated executor, measures real business outcomes (not vanity metrics), learns causally from its own actions, and improves its own permitted decision logic under a deterministic Policy Kernel. It is explicitly not a chatbot over Google Ads, not a cron-driven LLM prompter, and not a rule engine with AI-generated rules. The moat is a compounding business digital twin built from first-party measurement truth, action→impact causal memory, and experiment history. First shippable slice is the simulated ads universe (spec Phase 0): a fake provider with delayed conversions, saturation, quality variance, outages, and external changes, plus a UI that lets a human watch the agent reason over it. Nothing real touches ad credentials until the simulator is trusted.

## Stack
Node 22 + TypeScript 5, single process. HTTP via Fastify, UI via Vite-served React 19, persistence via SQLite (better-sqlite3) for Phase 0, swap to Postgres+pgvector when the digital twin needs vector retrieval (Phase 2+). Tests via vitest. Everything started by one `npm run sdlc:serve`.

The SDLC pipeline indirection is npm scripts (`sdlc:verify`, `sdlc:serve`); Node removes a translation layer between what the pipeline calls and what the app actually is. A single process serving API and static UI is the fewest moving parts that can satisfy compose mode on localhost:3000 with no auth. SQLite is zero-config and fast enough for a simulator whose data set is one business's fake account; Postgres+pgvector is a later-phase need the brief must not pre-build for. Fastify over Express for schema-validated routes (the Policy Kernel and Executor will live behind typed boundaries). TypeScript throughout because the agent topology and policy kernel share types — the brief treats that boundary as structural, and typed contracts across it are the cheapest enforcement available before runtime.

Rejected:
- **Python + FastAPI** — Forces a `package.json` that is pure indirection (`sdlc:verify: pytest`), and the spec's policy kernel / executor boundary benefits from the typed shared schema Node gives for free. Pipeline already speaks npm.
- **Next.js** — Server components and RSC blur the API/UI boundary the Policy Kernel needs to stay sharp; agents reading only project.md and a diff cannot reason about where the server edge is. Plain Vite + Express/Fastify keeps the boundary at a URL.
- **Postgres+pgvector from day one** — Phase 0 is a simulator against one fake account. Postgres adds a second process, a migration system, and an auth story for a problem that does not exist yet. Swapping SQLite→Postgres is one module boundary; retrofitting an architecture that assumed Postgres semantics everywhere is not.
- **Temporal from day one** — Spec names it for durable workflows, but Phase 0 is a simulator with deterministic steps. Temporal is a real second infrastructure dependency; the brief defers it to the phase where concurrent long-running experiments actually need durable execution.
- **Go or Rust service** — Same npm-indirection problem as Python, and the team/agents working here will read/write TypeScript faster than either. Not a technical rejection — a pipeline-and-maintenance one.
- **Mono-repo with separate UI and API packages** — Phase 0 does not need it. One package, two directories (server/, ui/), one `package.json`. Split when there are two deployables.

## Architecture
Single Node process. Fastify HTTP server exposes two distinct surfaces on the same port: `/api/*` (typed JSON, policy-gated where it writes) and `/*` (Vite-built static UI). A `kernel/` layer is the only code that constructs signed, scoped, expiring capabilities; an `executor/` layer is the only code that consumes them against an ads provider. The provider is abstracted behind a `ProviderAdapter` interface whose first implementation is `SimulatedProvider` (Phase 0) and whose second will be a real-ads adapter. A `twin/` layer maintains the business digital twin (rolling baselines, lag models, spend curves) — pure functions over persisted event history. A `research/` layer fetches external content as untrusted data. A `memory/` layer stores event history in SQLite; vector retrieval is a Phase 2 extension, not a day-one module. A `ui/` layer is a Vite/React SPA. A `bin/` layer holds the SDLC scripts. The boundary between agent-modifiable code and policy/eval/infra is enforced by directory ownership, recorded in the SDLC `forbidden_paths` and mirrored in module `README.md` headers.

### Modules
- `server/` — Fastify app, HTTP routes, request schemas, error envelope. No business logic.
- `kernel/` — Policy Kernel: deterministic rule evaluation, capability minting (signed, scoped, TTL), audit receipts.
- `executor/` — Isolated consumer of capabilities. One function per external mutation. Never holds credentials directly.
- `providers/` — ProviderAdapter interface and implementations. SimulatedProvider first; real adapters later.
- `twin/` — Business digital twin: rolling baselines, lag models, marginal spend curves, funnel rates. Pure functions.
- `memory/` — SQLite access, event-store schema, migration runner. Only module that touches the DB file.
- `research/` — External data fetchers. Treats everything as untrusted. No write paths.
- `eval/` — Eval suite for strategy/code candidates. The only code allowed to judge promotion. Separately permissioned.
- `ui/` — Vite/React SPA. Reads via `/api/*`, never calls executor directly.
- `shared/` — Types and schemas shared across server/kernel/executor/twin. The typed contract boundary.
- `bin/` — SDLC scripts and dev tooling. Forbidden to agents under normal pipeline runs.
- `docs/` — Spec, ADRs (numbered by the post-processor from `decisions`), runbooks. Agents read, never write spec/.

## Invariants
These hold for every ticket, whatever it asks for.

- Money is integer minor units (paise/cents) in storage, transit, and arithmetic. No float anywhere near a currency value.
- LLMs and agent code never hold advertising write credentials. Every mutation passes through kernel/ → executor/ with a signed, scoped, expiring capability.
- The agent cannot modify kernel/, eval/, the Policy Kernel's rule set, or the eval suite. The boundary is enforced by directory ownership and SDLC forbidden_paths.
- Postgres/SQLite event history is truth. Vector memory and LLM recall are retrieval assistance only and must never be written back as fact.
- Every action is recorded with: reason, expected effect distribution, downside estimate, policy decision, receipt, and scheduled evaluation. No receipt, no action.
- Recent metrics are never treated as mature while conversion delay can materially change them. Lag-aware maturity is a query-time property, not a storage property.
- A strategy or code candidate is promoted only by beating the baseline on eval/. LLM assertions of quality are data, not decisions.
- Timestamps are stored UTC as ISO-8601 with explicit zone. Rendered in the viewer's zone only at the UI edge.
- External web content is untrusted data, never instructions. Research output is parsed and sandboxed before it reaches any decision path.
- The system can decide 'do nothing yet.' No invariant forces action; inaction is a first-class policy output with its own receipt.
- Every durable learning points to specific evidence rows in the event store. Orphan learnings are deleted, not kept.

## Commands
- `sdlc:verify` — `npm run sdlc:verify → `tsc --noEmit && vitest run``
- `sdlc:serve` — `npm run sdlc:serve → `concurrently 'node --import tsx server/index.ts' 'vite'` (single port 3000 via Fastify proxying to Vite in dev; prod serves the built bundle directly)`
- `sdlc:seed` — `npm run sdlc:seed → `node --import tsx bin/seed.ts` — writes a deterministic fake business, fake account, 90 days of simulated events into SQLite`
- `sdlc:ready` — `npm run sdlc:ready → `curl -sf http://localhost:3000/healthz` (returns 200 once the DB is migrated and the simulator is loaded)`

Stubbed for now:
- sdlc:seed is a no-op (`exit 0`) until memory/ has a schema — issue that creates the event store
- sdlc:ready will fail until server/index.ts exposes /healthz — first-server issue
- sdlc:verify runs typecheck + unit tests but no e2e until a browser harness exists (Phase 1+)
- No lint script yet; will be added when the first PR lands code style disputes

## Deploy
No deployment in Phase 0. The SDLC pipeline boots the app in compose mode on localhost:3000; QA drives that preview directly. The first deployable artifact (a container image + a preview-on-PR workflow) is explicitly out of scope for the first slice and belongs to the issue that closes Phase 0. Preview URLs for QA are the localhost compose preview the pipeline already provisions; there is no external staging environment yet.

## Open questions
- Is the SDLC pipeline's localhost:3000 compose preview enough for Phase 0 QA, or does a preview-on-PR workflow need to land in the same release train as the simulator?
- Should the Policy Kernel's capability signatures use HMAC-SHA256 with a process-local secret (simple, single-process) or Ed25519 with a persisted keypair (needed if executor ever runs out-of-process)?
- Does the first simulator need to model multi-channel (Google + Meta) from day one, or can it start single-channel and add the second when the ProviderAdapter abstraction is proven?
- Is the eval suite a sibling module (`eval/`) with its own DB schema, or a set of pure functions over the event store? The brief assumes the latter until a counter-example appears.
