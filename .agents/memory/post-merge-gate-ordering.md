---
name: post-merge gate ordering hides latent suite failures
description: Why a "post-merge failed" alert can understate how many tests are actually broken on main
---

# Post-merge gate ordering masks downstream failures

`scripts/post-merge.sh` runs `set -e` and executes its CI gates in a fixed order:
1. `npm install`
2. `scripts/check-db-test-coverage.sh` (DB-writer secret-leak test coverage) — **early**
3. `npx tsx tests/runIntegrationTests.ts` (the full ~218-file integration suite + vitest) — **later**
4. then several dashboard/static guards (inline-handler CSP, RTL classes, th-scope, console-log, i18n).

**Why this matters:** because of `set -e`, the FIRST failing gate aborts the whole
script. For a long time every post-merge died at gate #2 (a couple of writers were
missing companion `*.test.ts`), so the platform's failure report only ever showed
the coverage-gate diagnostic. The full integration suite at gate #3 was never
reached, so its failures stayed latent/invisible.

The moment gate #2 is made green, gate #3 runs for the first time in a while and
can surface a large backlog of pre-existing failures (RBAC route-map gaps,
dashboard CSP/RTL/a11y violations, route logic, redaction, vitest business-logic
asserts). These are NOT caused by whatever change unblocked gate #2.

**How to apply:** when a post-merge failure points at one early gate, fixing it can
expose a second wave. Before assuming the new wave is your regression, check git
(`git show HEAD:<file>`) — most will be committed content untouched by your change
and often owned by other in-progress tasks (e.g. an "Authorization" task owns the
RBAC `ROUTE_PERMISSION_MAP` coverage failures). Don't silently swallow gate
failures to force green; fix what's yours and route the rest to the owning task.

## Inline-handler guard: post-merge runs a STRICTER flag than the test

`scripts/lint-dashboard-handlers.sh` has two modes. The Playwright/tsx test
`tests/noInlineHandlers.test.ts` spawns it WITHOUT args (only scans for inline
`on*=` handler attributes). `scripts/post-merge.sh` runs it WITH
`--check-inline-scripts`, which ALSO enforces that every inline `<script>` block
lives on `INLINE_SCRIPT_NONCE_ALLOWLIST` in `scripts/check-handlers.cjs`.

**Consequence:** the inline-handler *test* can be green while *post-merge* still
fails on `inline-script-no-nonce` violations. A guard "passing as a workflow" does
NOT prove post-merge passes — re-run the exact post-merge invocation.

**How to apply:** any NEW dashboard `*.html` page with an inline `<script>` (no
`src=`, no source-level `nonce=`) must be added to `INLINE_SCRIPT_NONCE_ALLOWLIST`,
AND only after confirming the page is served via a non-`/api/` `text/html` route so
`injectCspNonce` (src/mastra/middleware/index.ts) stamps the nonce at request time.
The allowlist also fails on STALE entries (deleted file or page no longer has an
unnonced inline script), so deleting a page means deleting its allowlist line.
**Why:** allowlisting asserts "this page gets its nonce from middleware"; if a page
is ever served outside that middleware the allowlist silently masks a real prod CSP
break — so verify the serving route before adding.
