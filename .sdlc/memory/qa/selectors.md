# Stable selectors

Landed with #27 (foundation) and #30 (Meta read); the approvals and guardian sections added
with #53. Verified against `src/web/pages.js` and `src/web/client.js`. Prefer `data-testid`
and `data-*` hooks — they survive copy and layout changes; class names (`.panel`,
`.kpi-card`, `.skeleton`) are styling hooks, not assertions.

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

## Approvals / policy / guardian (#53)

`/approvals` renders four regions plus a chrome banner. On a fresh seed: **three** pending
cards and **one** lapsed row, no executed receipts.

- `[data-testid="approval-queue"]` — the pending panel, titled `Pending approvals · N`.
- `[data-testid="approval-card"]` — one per pending approval. Carries `data-approval-id`
  and `data-tenant-id` on the `<li>`, plus `data-approval-card`.
- `[data-testid="approval-executed"]` / `[data-testid="executed-receipt"]` — the executed
  receipts panel and its rows. **Only receipts with a non-null `approval_id` render here**;
  an autonomous execution is audited in `audit_events` instead, so "zero executed
  receipts" stays true on a second pass of a QA script.
- `[data-testid="approval-lapsed"]` / `[data-testid="lapsed-row"]` — lapsed rows carry
  **no control of any kind**. Asserting the absence of approve/reject/re-decide on these
  rows is the point, not an oversight.
- `[data-testid="posture-table"]` with `[data-testid="posture-row-<action_class>"]` —
  autonomy posture per action class, in the pinned order `campaign-status`,
  `budget-change`, `creative-refresh`, `new-geography`, `campaign-launch`. Assert rows by
  this order, not by position in the DOM.
- `[data-testid="approval-decision-result"]` — the region both the server-painted and the
  client-painted result land in. It is one region, so a second decision replaces the
  first rather than stacking. It renders on whichever page the client navigates to
  carrying the decision parameters, so it can appear outside `/approvals`.
- `[data-testid="approval-toast"]` — a successful approve, naming the receipt id and
  `reconciliation 'agreed'`. A **failed** approve shows no toast and no
  `approval-rejected`; it renders the failed-reconciliation panel with
  `reconciliation 'unknown'` instead. `[data-testid="approval-rejected"]` is the
  rejected-approve sibling. An unrecognised decision renders nothing at all.
- `[data-testid="guardian-banner"]` — on **every** page, not just `/approvals`, whenever a
  freeze is active. Copy names the affected scope: `Automation is frozen (<scope>).`
- `[data-testid="guardian-incident"]` — the recent-incidents list, with `data-incident-id`.
- Experiment card on `/experiments`: `[data-testid="experiment-card"]` (with
  `data-experiment-id`), `[data-testid="caps"]` (max spend / max downside),
  `[data-testid="stop-rules"]`, `[data-testid="exp-state"]`, `[data-testid="data-through"]`.

### The control-attribute invariant

Every decision control carries **both** `data-approval-id` and `data-tenant-id` on the
control itself, never on an ancestor. `client.js` reads them from `event.currentTarget`
with no `closest()` walk, so a control missing either attribute produces a request with
no approval id and a 404 that reads like a bad data row. If a click 404s unexpectedly,
check the control's own attributes before you check the data.

The controls are `[data-action="approve-decision"]`, `[data-action="reject-decision"]` and
`[data-action="re-decide"]`.
