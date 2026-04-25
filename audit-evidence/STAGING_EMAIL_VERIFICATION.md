# Post-Restore Sweep — Staging Channel Verification

**Tasks:** #574 (email channel), #584 (Slack + in-app channels)
**Scripts:** `scripts/verifyPostRestoreSweepEmail.ts`,
`src/utils/redactHistoricalLogs.ts` (`dispatchPostRestoreSweepAlert`),
`src/utils/resendMail.ts`, `src/utils/notificationHub.ts`
**Owner:** Security / on-call. Re-run after any change to
`dispatchPostRestoreSweepAlert`'s email body, Slack body, or
notification payload; to the `POST_RESTORE_SWEEP_ALERT_EMAIL` /
`SLACK_WEBHOOK_URL` contracts; to the Resend From-domain; or to the
notification hub's in-app rendering of `security/redaction-sweep`
critical alerts.

---

## Why this exists

Task #555's unit tests (`tests/redactPostRestoreSweepAlert.test.ts`,
102 assertions) cover the dispatcher contract — recipients trimmed,
body includes the timestamp + per-table counts, channel marked
`succeeded`/`failed` in the outcome — but they stub `sendResendEmail`,
the Slack webhook `fetch`, and `createNotification`.

That means **no automated check** ever proves that:

1. The real Resend API accepts the payload
   `dispatchPostRestoreSweepAlert` produces (i.e. From domain is
   verified, recipient list shape is valid, subject length is
   acceptable).
2. The HTML the dispatcher emits renders correctly in the mail
   clients on-call actually uses (Gmail web, Outlook, Apple Mail) —
   the `<h2>` / `<h3>` / `<ul>` / `<a href>` markup specifically must
   survive both Gmail's HTML rewrite and Outlook's stricter renderer
   without losing the timestamp, the four per-table counts, or the
   `Open the audit log` link.
3. The Slack webhook accepts the payload and Slack itself renders
   the `:rotating_light:` emoji as a glyph, the `*headline*` as bold,
   and the inline ``` `code` ``` segments wrapping the timestamp and
   the `event_logs=…, nc_change_history=…, …` detail line as
   monospace — without truncating the long detail line at Slack's
   ~3 000-character text limit.
4. The in-app notification hub surfaces the alert in the dashboard
   bell badge with `priority="critical"` styling, renders the same
   timestamp + per-table counts, and that the `action_url`
   (`/audit-logs`) actually resolves to the audit-log page in the
   staging dashboard (rather than 404'ing because the route was
   renamed).

A regression in any of these layers would only surface during an
actual incident — exactly when on-call needs every channel to be
readable. This procedure exists so an operator can prove all three
channels work end-to-end on staging without waiting for a real
database restore to trigger the boot sweep.

## Pre-requisites

1. **Staging environment access.** A shell against the staging
   deployment (not production — staging Resend keys live there). The
   procedure must NOT be run against the production deployment unless
   the operator deliberately wants to page production on-call.
2. **A real test inbox per mail client to verify.** At minimum:
   - One `@gmail.com` address (Gmail web).
   - One `@outlook.com` / `@hotmail.com` / `@live.com` address
     (Outlook web).
   - Recommended: one `@icloud.com` / `@me.com` address (Apple Mail
     desktop or iOS).
3. **Staging env vars set** for the duration of the run:
   - `RESEND_API_KEY` — the real staging Resend API key. Must be
     ≥ 20 characters or `isResendConfigured()` rejects it and the
     dispatcher silently skips the channel (the helper script's
     pre-flight check catches this and exits 1).
   - `POST_RESTORE_SWEEP_ALERT_EMAIL` — comma-separated list of the
     test inboxes from step 2. Whitespace and empty entries are
     trimmed by the dispatcher (covered by unit tests), but for this
     run keep the list clean.
   - `RESEND_FROM_EMAIL` — optional. Defaults to
     `WalaPlus QMS <onboarding@resend.dev>` (Resend's testing
     sender). Override only if staging uses a verified custom
     domain.
4. **For the Slack channel verification** (Procedure B below):
   - A **sandbox Slack channel** the operator can spam without
     paging the real on-call rotation. A `#qms-alerts-staging` (or
     equivalent) channel with an Incoming Webhook configured against
     it is the standard setup. **Do not point `SLACK_WEBHOOK_URL`
     at the production on-call channel for this dry-run** — the
     `:rotating_light:` payload is indistinguishable from a real
     boot-time alert.
   - `SLACK_WEBHOOK_URL` exported in the shell that runs the helper
     with `--include-slack`. The dispatcher only attempts the Slack
     channel when this is set; the helper script's pre-flight
     refuses `--include-slack` without it and exits 1.
5. **For the in-app notification verification** (Procedure C below):
   - A staging dashboard login (any role that can see the bell
     icon — admins always can). The notification is created with
     `priority="critical"`, `channel="in_app"` and
     `module="security/redaction-sweep"`, so it lands in every
     user's bell badge regardless of per-user notification
     preferences.
   - The staging deployment must be **running and reachable** in
     the browser so the operator can refresh the dashboard and
     watch the bell badge update. The helper does not poke the
     frontend — it only writes to the notifications table via
     `createNotification`.

## Procedure

> The procedure is split into three independent sub-procedures (A
> for email, B for Slack, C for in-app). A single helper invocation
> can cover all three by combining the `--include-slack` and
> `--include-notification` flags, but the **visual checks for each
> channel are independent** — a green run on email does not imply
> the Slack body or the bell badge is healthy. Operators may run
> the sub-procedures together or on different days, but each one
> must populate its own row in its own run-log table below.

## Procedure A — Email channel

### Step 1 — Trigger the email

From the staging shell:

```bash
RESEND_API_KEY="<staging Resend key>" \
POST_RESTORE_SWEEP_ALERT_EMAIL="ops-test+gmail@…,ops-test+outlook@…,ops-test+icloud@…" \
npx tsx scripts/verifyPostRestoreSweepEmail.ts
```

The helper:

- Builds a synthetic `SweepResult` with non-zero per-table counts
  (default `event_logs=5, nc_change_history=7, capa_change_history=11,
  ai_pending_actions=2`). Override with
  `--counts=EL,NC,CAPA,AI` if you want to verify rendering of a
  specific shape.
- Calls the real `dispatchPostRestoreSweepAlert(result, deps)` with
  **the platform-notification and Slack channels stubbed out** so the
  dry-run does not pollute the staging notifications table or page
  the real Slack channel. Pass `--include-notification` /
  `--include-slack` if you also want to exercise those surfaces (the
  latter requires `SLACK_WEBHOOK_URL`).
- The email channel is **never** stubbed — it always runs against
  the real `sendResendEmail` helper. That is the whole point.

Expected stdout (success):

```
========================================================================
Task #574 — Post-restore sweep email staging dry-run
========================================================================
Sweep timestamp:    2026-04-25T…Z
Recipients:         ops-test+gmail@…, ops-test+outlook@…, ops-test+icloud@…
Per-table counts:   event_logs=5, nc_change_history=7, capa_change_history=11, ai_pending_actions=2
Channels enabled:   email_recipients

📧 [ResendMail] Sending email to: ops-test+gmail@…, ops-test+outlook@…, ops-test+icloud@…
📧 [ResendMail] From: WalaPlus QMS <onboarding@resend.dev>
📧 [ResendMail] Subject: 🚨 WalaPlus post-restore redaction sweep rewrote 25 historical row(s)
✅ [ResendMail] Email sent successfully. ID: <resend-id>

Dispatcher outcome:
{
  "dispatched": true,
  "triggers": { "event_logs": 5, "nc_change_history": 7, … },
  "channelsAttempted": ["platform_notification", "email_recipients"],
  "channelsSucceeded": ["platform_notification", "email_recipients"]
}

✅ Email accepted by Resend. Now open each recipient's inbox …
```

The script exits 0 when Resend accepts the payload (i.e.
`channelsSucceeded` includes `email_recipients`) and exits 1
otherwise. **A 0 exit is not enough** — the visual checks below
matter just as much, because Resend will return success even if the
HTML is mangled.

### Step 2 — Visual checks per mail client

Open each recipient inbox and confirm the following render
correctly. Take a screenshot of each client and store it alongside
this file (e.g. `audit-evidence/screenshots/sweep-email-gmail.png`).

#### Subject line

- [ ] Starts with the 🚨 emoji (Gmail and Outlook both render it;
      Apple Mail renders the system glyph).
- [ ] Includes the total row count, e.g. `… rewrote 25 historical
      row(s)`.

#### Body — header

- [ ] `Post-restore redaction sweep rewrote historical rows` is
      rendered as a heading (`<h2>`), larger than the body text.

#### Body — narrative paragraph

- [ ] The sweep timestamp appears inside an inline code block
      (`<code>…Z</code>`) and is the same value the script printed in
      stdout.
- [ ] The sentence about `nc_change_history` / `capa_change_history`
      means a backup restore reintroduced credentials is intact (no
      truncation, no broken markup).

#### Body — per-table count list

- [ ] A bulleted list of four items renders, each with the table
      name in inline code:
  - `event_logs: 5`
  - `nc_change_history: 7`
  - `capa_change_history: 11`
  - `ai_pending_actions: 2`
- [ ] Numbers match the values passed via `--counts` (or the
      defaults).

#### Body — audit-logs link

- [ ] An `Open the audit log` hyperlink renders below the list.
- [ ] Hovering shows the `href` resolves to `/audit-logs`. Note: it
      is a relative URL by design — the dispatcher does not know the
      deployed origin. **Operators verifying this should manually
      open the staging dashboard's `/audit-logs` page in a browser to
      confirm the same path is reachable.** If a future task makes
      the link absolute, update both `dispatchPostRestoreSweepAlert`
      and this checklist.

#### Plain-text fallback (Outlook / Apple Mail offline)

- [ ] In a client that prefers the text part (e.g. Apple Mail with
      "Plain text" mode), the timestamp and the
      `event_logs=…, nc_change_history=…, …` line both appear without
      HTML tags leaking through.

### Step 3 — Capture evidence

For the run to count as completed, append a row to the **email run
log** (the first table at the bottom of this file) with:

- The date the run was performed (UTC).
- The dispatcher's exit code from Step 1 (`0` = success).
- A `✅` / `❌` per mail client checked.
- A link to the screenshots folder in this directory.
- The operator's initials.

If any visual check fails, **do not mark the row green** — open a
follow-up task referencing the failure mode (which client, which
checklist item) and link the screenshot.

## Procedure B — Slack channel

### Step 1 — Trigger the Slack post

Point `SLACK_WEBHOOK_URL` at a **sandbox** channel (see
Pre-requisites step 4 — never the production on-call channel) and
re-run the helper with `--include-slack`:

```bash
RESEND_API_KEY="<staging Resend key>" \
POST_RESTORE_SWEEP_ALERT_EMAIL="ops-test+gmail@…" \
SLACK_WEBHOOK_URL="https://hooks.slack.com/services/…sandbox…" \
npx tsx scripts/verifyPostRestoreSweepEmail.ts --include-slack
```

What changes versus Procedure A:

- `--include-slack` removes the no-op `fetch` stub the script
  installs by default, so the dispatcher posts to the real webhook.
- The script's pre-flight rejects `--include-slack` without
  `SLACK_WEBHOOK_URL` and exits 1 — there is no silent skip.
- The dispatcher records `slack_webhook` in `channelsAttempted`.
  The `Real channels:` line in stdout will list it explicitly.
- Slack's webhook returns HTTP 200 with body `ok` on success. The
  dispatcher treats any non-2xx as a delivery failure and logs a
  `[Redaction] … Slack webhook returned HTTP …` warning, in which
  case `channelsSucceeded` will **not** include `slack_webhook` —
  treat that as a failed run regardless of the visual checks.

You can combine Procedures A and B in a single invocation by leaving
the email env vars set; the email channel always runs and the Slack
channel is added on top. A combined run still requires populating
both run-log tables.

### Step 2 — Visual checks in Slack

Open the sandbox channel and confirm the most recent post from the
incoming-webhook bot. Take a screenshot and store it alongside this
file (e.g. `audit-evidence/screenshots/sweep-slack-sandbox.png`).

#### Headline line

- [ ] The first line begins with the 🚨 glyph (Slack renders
      `:rotating_light:` as the system emoji — if you see the
      literal `:rotating_light:` text instead, Slack failed to
      parse the emoji shortcode and the regression must be filed).
- [ ] `Post-restore redaction sweep rewrote historical rows`
      renders **bold** (Slack's `*…*` markdown), not as literal
      asterisks.

#### Timestamp line

- [ ] `Sweep timestamp:` is followed by the same ISO-8601
      timestamp the script printed in stdout, wrapped in Slack's
      monospace style (the inline `` ` … ` `` segment).
- [ ] No truncation — the trailing `Z` must be visible. Slack
      truncates `text` payloads at ~3 000 characters; if the
      timestamp is missing, the body has grown beyond that and the
      dispatcher needs to migrate to Block Kit.

#### Per-table counts line

- [ ] `Per-table counts:` is followed by a single monospace
      segment containing
      `event_logs=…, nc_change_history=…, capa_change_history=…, ai_pending_actions=…`
      with the same numbers the script reported.
- [ ] All four counters are present — Slack must not have wrapped
      the line such that one is hidden behind a "Show more" link.

#### Narrative paragraph

- [ ] The credentials-warning sentence renders intact, with
      `nc_change_history` and `capa_change_history` shown as
      monospace tokens (not as raw backticks).

#### Notification behaviour

- [ ] The post triggers a Slack desktop / mobile notification
      (assuming the test operator's Slack notification settings
      allow it for the sandbox channel) — confirms Slack treats
      the message as a normal channel post, not a thread reply.
- [ ] No `<!channel>` / `<!here>` mention fires. The dispatcher
      intentionally does not use channel-wide pings because the
      production channel is on-call-only; if you see a mention,
      something injected one and the dispatcher source must be
      audited.

### Step 3 — Capture evidence

Append a row to the **Slack / in-app run log** (the second table
at the bottom of this file) with the date, exit code, the per-check
result for the Slack column, the screenshot path, and operator
initials. Leave the in-app columns blank if you did not also run
Procedure C in the same session.

## Procedure C — In-app notification channel

### Step 1 — Trigger the in-app notification

Re-run the helper with `--include-notification`. You can stack
flags to also run email and Slack in the same invocation:

```bash
RESEND_API_KEY="<staging Resend key>" \
POST_RESTORE_SWEEP_ALERT_EMAIL="ops-test+gmail@…" \
SLACK_WEBHOOK_URL="https://hooks.slack.com/services/…sandbox…" \
npx tsx scripts/verifyPostRestoreSweepEmail.ts \
  --include-notification --include-slack
```

What changes versus Procedure A:

- `--include-notification` removes the no-op `createNotification`
  stub, so the dispatcher writes a real row via
  `notificationHub.createNotification` against the staging
  `notifications` table.
- The notification is created with
  `module="security/redaction-sweep"`, `priority="critical"`,
  `channel="in_app"`, `related_entity_type="SYSTEM"`,
  `related_entity_id="boot_redaction_sweep"`, and
  `action_url="/audit-logs"`. Any deviation from these values is
  itself a regression worth opening a task on.
- The dispatcher records `platform_notification` as both
  `attempted` and (on success) `succeeded`. A `succeeded` outcome
  here is necessary but not sufficient — the visual checks below
  matter because the bell-badge UI is rendered by the dashboard,
  not the dispatcher.

### Step 2 — Visual checks in the staging dashboard

Log in to the staging dashboard as a user who can see the bell
badge. Hard-refresh after triggering the helper so the
notifications query re-fetches, then confirm the following. Take
a screenshot of the bell-tray expanded view and store it
alongside this file (e.g.
`audit-evidence/screenshots/sweep-inapp-bell.png`).

#### Bell badge

- [ ] The bell icon shows an unread count incremented by 1 (or
      more, if previous staging runs left unread alerts) — i.e.
      the badge **does fire**. If the count does not change, the
      notifications query is filtering the row out (e.g. by
      module or priority) and the bell-badge wiring is broken
      for `security/redaction-sweep`.

#### Notification card in the tray

- [ ] The card title reads
      `Post-restore redaction sweep rewrote historical rows`
      (verbatim — no truncation, no extra prefix injected by the
      hub).
- [ ] The card body contains the same ISO-8601 timestamp the
      script printed in stdout.
- [ ] The card body contains the four per-table counts in the
      same `event_logs=…, nc_change_history=…, capa_change_history=…, ai_pending_actions=…`
      shape — the numbers must match what the script reported.
- [ ] The card is rendered with the **critical** styling
      (typically a red accent / icon, depending on the dashboard
      theme). A neutral or info-blue card means the
      `priority="critical"` field is being ignored downstream.

#### Action URL

- [ ] Clicking the card navigates to `/audit-logs` in the staging
      dashboard.
- [ ] That URL **resolves** — the audit-log page renders, no 404,
      no blank screen. The dispatcher does not know whether the
      route still exists; this manual check is the only thing
      catching a future rename of `/audit-logs`.

### Step 3 — Capture evidence

Append a row to the **Slack / in-app run log** (the second table
at the bottom of this file) — or amend the row from Procedure B if
the runs were combined — filling in the in-app columns. Same
failure rule as the other procedures: any unchecked visual item
means the row stays un-greened and a follow-up task is filed.

## Re-run schedule

Re-run the relevant procedure:

- **Procedure A (email)** — whenever
  `dispatchPostRestoreSweepAlert`'s HTML / text email body is
  modified (grep for the function name in `git log`); whenever the
  From domain changes (e.g. switching off `onboarding@resend.dev`
  to a verified custom sender); whenever the recipient-list
  contract (`POST_RESTORE_SWEEP_ALERT_EMAIL` parsing or the
  DB-backed admin list resolution) changes; whenever a major
  version of Resend's SDK is upgraded.
- **Procedure B (Slack)** — whenever the Slack `text` body in
  `dispatchPostRestoreSweepAlert` is modified (search the function
  for the `slackBody` literal); whenever the channel migrates from
  the legacy `text` field to Block Kit / `blocks`; whenever the
  `SLACK_WEBHOOK_URL` contract changes (e.g. moving to per-tenant
  webhooks).
- **Procedure C (in-app)** — whenever the
  `createNotification(...)` call inside
  `dispatchPostRestoreSweepAlert` changes any of `module`,
  `priority`, `channel`, `title`, `message`, or `action_url`;
  whenever the notification-hub schema or the bell-badge component
  in the dashboard is materially refactored; whenever the
  `/audit-logs` route is renamed or relocated.
- **All three** — at least once per quarter as a baseline
  freshness check, even if no code in the dispatcher or the
  notification hub has changed.

## Run logs

### Email channel (Procedure A)

| Date (UTC) | Counts (EL,NC,CAPA,AI) | Exit | Gmail | Outlook | Apple Mail | Screenshots | Operator |
|------------|------------------------|:----:|:-----:|:-------:|:----------:|-------------|----------|
| _pending first staging run_ | 5,7,11,2 | — | — | — | — | — | — |

### Slack & in-app channels (Procedures B and C)

Track Slack and in-app verifications separately from the email
channel above. A single row may cover both channels when they are
exercised in the same helper invocation; otherwise leave the
unverified columns as `—` and add a second row when the other
channel is run.

| Date (UTC) | Counts (EL,NC,CAPA,AI) | Channels run | Exit | Slack | In-app bell | Action URL resolves | Screenshots | Operator |
|------------|------------------------|--------------|:----:|:-----:|:-----------:|:-------------------:|-------------|----------|
| _pending first staging run_ | 5,7,11,2 | — | — | — | — | — | — | — |
