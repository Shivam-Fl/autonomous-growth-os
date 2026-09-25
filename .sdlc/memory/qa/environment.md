# QA environment notes

Landed with #27 (foundation) and #30 (Meta read); verified against `src/index.js`, `src/api/routes.js`, `src/web/pages.js`.

## Boot
- `npm run sdlc:serve` boots with zero external services; the only runtime dependency is express. No login anywhere — QA drives the local instance directly.
- `PORT` (default 3000) picks the port; `DB_PATH` (default `./data/app.db`) picks the SQLite file. `npm run sdlc:ready` probes `http://localhost:${PORT:-3000}/health`, so export the same `PORT` when probing a non-default port.
- `GET /health` returns 200 `{"status":"ok","version":"..."}`.
- `npm run sdlc:seed` writes the demo tenant (`tenant_demo`, "Demo Tenant") idempotently through the repository layer; re-running is safe. After seeding, the dashboard header names the demo tenant instead of showing the empty state.

## Preview overrides (all read-only, never write)
- `?state=empty|ideal|loading|partial|error` on any of `/ /journal /opportunities /experiments /approvals` forces that shell for QA on a fresh database. Unknown values are ignored (page falls back to store-derived state).
- `?state=empty` also forces the header to read `No connected account` — header follows the effective (post-override) state, so header and body never disagree.
- `?meta_error=quota|revoked` on `/` drives the fake Meta provider's failure injection (`quota` → check `provider-sync/quota`, `revoked` → `provider-sync/permission`). Unknown values are ignored. The provider is constructed per request and holds no cross-request state, so one tab's simulated failure never leaks into another tab.
- The error-panel Retry button strips `?state=` before navigating (`src/web/client.js`), so Retry always re-reads live state instead of re-rendering the forced shell.

## Failure shapes to assert
- Unknown `/v1` paths (e.g. `POST /v1/events`) return 404 `{code:"NOT_FOUND",message:"no API route for <METHOD> <full path with /v1 prefix>"}` — never a stack trace. Note for test authors: Express strips the mount prefix from `request.path`, so the handler rebuilds the reported path from `baseUrl + path` (`src/api/routes.js`).
- Unhandled errors return 500 `{code:"INTERNAL",message:"internal error"}` with the detail logged server-side only.
