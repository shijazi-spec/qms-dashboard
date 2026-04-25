# qms-dashboard

## Pre-commit hooks

This repo uses [husky](https://typicode.github.io/husky/) + [lint-staged](https://github.com/lint-staged/lint-staged)
as the single orchestrator for **all** local pre-commit checks, so every
violation surfaces in your terminal immediately instead of after a failed CI
build.

### What runs on `git commit`

The husky hook at `.husky/pre-commit` runs, in order:

1. **`npx lint-staged`** — driven by `.lintstagedrc.cjs`, for every staged
   `*.ts` file:
   - `prettier --write` on the staged files (auto-fixes formatting).
   - `npm run check` (full project `tsc --noEmit`) to catch type errors that
     span multiple files.
2. **`bash .githooks/pre-commit`** — Content Security Policy guardrails
   (`scripts/check-no-inline-styles.sh` and
   `scripts/check-no-inline-handlers.sh`) described in
   `docs/Security_Operations_SOP.md §5.5`. The script smart-skips when the
   staged change set touches no files under `dashboard/` or `src/mastra/`, so
   unrelated commits stay instant.

If any step fails, the commit is aborted with a clear error message. Prettier
auto-formats in place, so re-running `git add` on the affected files is usually
all you need.

### Setup for new contributors

The hook is installed automatically the first time you run `npm install` (via
the `prepare` script, which runs `husky` and sets
`core.hooksPath = .husky/_`). No manual steps required. To verify:

```sh
git config --get core.hooksPath   # should print `.husky/_`
ls .husky/pre-commit              # should exist and be executable
```

If it isn't set up (e.g. you cloned with `--no-scripts` or installed deps with
a flag that skipped lifecycle scripts), run:

```sh
npm run prepare
```

### Bypassing the hook

Use sparingly, and document the reason in the commit message:

```sh
git commit --no-verify
```

The same Prettier, TypeScript, and CSP checks still run in CI via `npm test` /
the dedicated typecheck and format jobs and will block the merge.

## Integration tests

Certain integration tests talk to real third-party APIs. They are **opt-in**: each
file skips gracefully (exit 0) when the required credentials are absent, so the
normal `npm test` run is never broken by missing secrets.

### Tool-health on-call notifier (`tests/toolHealthAlertNotifier.integration.ts`)

Posts a real Slack message and/or Resend email with the **production renderers**
to verify the Block Kit schema, button URL parsing, plaintext fallback length,
and HTML character escaping before any change reaches the on-call path.

| Variable | Purpose |
|---|---|
| `SLACK_BOT_TOKEN` | Slack bot token with `chat:write` scope |
| `SLACK_TEST_CHANNEL` | Channel id or name to receive the test message |
| `RESEND_API_KEY` | Resend API key |
| `RESEND_TEST_EMAIL` | Delivery address (e.g. `delivered@resend.dev` for a Resend test address) |
| `TOOL_HEALTH_APP_URL` | _(optional)_ Public origin of the app; enables the clickable button in the Slack Block Kit message |

At least one credential pair (`SLACK_BOT_TOKEN` + `SLACK_TEST_CHANNEL`, or
`RESEND_API_KEY` + `RESEND_TEST_EMAIL`) must be set for the tests to run.
Set these as Replit secrets or in a local `.env` file — **never commit them to
source control**.

```sh
# Run the integration tests
npx tsx tests/toolHealthAlertNotifier.integration.ts
```

### RBAC HTTP integration suite (`tests/rbac*.integration.ts`)

Two HTTP-level tests drive real `fetch()` calls against the running dev server
using signed session cookies for five different roles, and assert exact 403/200
outcomes per role per route. They catch middleware-ordering, cookie-parsing,
and `ROUTE_PERMISSION_MAP` regressions that the in-process unit tests cannot:

- `tests/rbacRouteLockdown.integration.ts` — KPI / executive / analytics /
  scorecard / health-pulse / infographic routes (task #35 lockdown).
- `tests/rbacReportRoutes.integration.ts` — `/api/reports/*` endpoints
  (department_viewer 403 vs executive 200).

Both files require `DATABASE_URL` and `SESSION_SECRET` (the **same**
`SESSION_SECRET` the dev server uses, otherwise every signed cookie comes back
401 instead of 403 and silently masks regressions). Each file exits with a
clear error if either is absent.

The wrapper script does an upfront env-var check and then runs both files
sequentially:

```sh
DATABASE_URL=postgresql://... \
SESSION_SECRET=local-dev-secret \
bash scripts/run-rbac-integration-tests.sh
```

CI runs this suite in two places:

- `.github/workflows/test.yml` (standard test job) boots postgres + the dev
  server with both env vars set and `RUN_RBAC_INTEGRATION_E2E=1`, so the
  same `npm test` invocation that runs the unit tests also drives the RBAC
  HTTP integration suite. Any route-lockdown regression fails the standard
  test job, not just a separate workflow.
- `.github/workflows/rbac-integration-tests.yml` (dedicated workflow)
  re-runs only the RBAC HTTP integration suite for fast feedback when
  iterating on RBAC middleware in isolation.

To include the suite in a local `npm test` run, set
`RUN_RBAC_INTEGRATION_E2E=1` (with `DATABASE_URL`, `SESSION_SECRET`, and the
dev server reachable at `BASE_URL`):

```sh
RUN_RBAC_INTEGRATION_E2E=1 \
DATABASE_URL=postgresql://... \
SESSION_SECRET=local-dev-secret \
npm test
```
