# qms-dashboard

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

### Report-route RBAC (`tests/rbacReportRoutes.integration.ts`)

Spins up real HTTP requests against the running server using temporary test users.
Requires `DATABASE_URL` and `SESSION_SECRET` (both required; the file exits with
an error if they are absent).

```sh
npx tsx tests/rbacReportRoutes.integration.ts
```
