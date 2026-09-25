# Stable selectors

Landed with #27 (foundation) and #30 (Meta read); verified against `src/web/pages.js`. Prefer `data-testid` and `data-*` hooks — they survive copy and layout changes; class names (`.panel`, `.kpi-card`, `.skeleton`) are styling hooks, not assertions.

## Page chrome (every page)
- `body[data-page]` — the route (`/`, `/journal`, …); `body[data-state]` — the effective state (`empty|ideal|loading|partial|error`). Assert these first; they disambiguate every shell.
- `#tenant-name[data-testid="tenant-name"]` — header account indicator. `No connected account` when empty, tenant name otherwise.
- `#live-region[aria-live="polite"]` — client announces `<page> is showing the <state> preview state` on load and `Retrying…` on retry.
- `a.skip-link[href="#main"]`, `main#main` — keyboard / skip-link targets.

## Per-page empty states
- `[data-testid="dashboard-empty"]`, `[data-testid="journal-empty"]`, `[data-testid="opportunities-empty"]`, `[data-testid="experiments-empty"]`, `[data-testid="approvals-empty"]`.

## Meta dashboard regions (#30)
- `[data-testid="meta-campaigns"]`, `[data-testid="meta-adSets"]` (capital S — matches the code's `adSets` key, not `adsets`), `[data-testid="meta-ads"]`, `[data-testid="meta-insights"]`. Titles carry the row count (`Meta campaigns · N rows`); assert the count in the heading rather than counting rows when possible.
- `[data-testid="meta-last-good"]` — `Meta last good sync <timestamp>` line, present in ideal and error states.
- `[data-testid="meta-unavailable"]` — shown when no provider is wired (not reachable via the normal route, which always builds a fake provider; only for direct `renderPage` callers).
- Error panel names the failing check in its copy: `provider-sync/quota` or `provider-sync/permission`; prior rows stay visible below it.

## Error / retry controls
- `.panel-error [data-action="retry"]` — the retry button; focused automatically on error pages, so keyboard assertions start there. Its `data-retry-href` is the retry target.
- `.banner-warn[role="status"]` — stale-data banners on partial states.
