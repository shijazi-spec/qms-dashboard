# Post-Restore Sweep — Staging Email-Delivery Verification

**Task:** #574 — Verify the post-restore sweep email actually delivers
in staging
**Scripts:** `scripts/verifyPostRestoreSweepEmail.ts`,
`src/utils/redactHistoricalLogs.ts` (`dispatchPostRestoreSweepAlert`),
`src/utils/resendMail.ts`
**Owner:** Security / on-call. Re-run after any change to
`dispatchPostRestoreSweepAlert`'s email body, the
`POST_RESTORE_SWEEP_ALERT_EMAIL` contract, or the Resend From-domain.

---

## Why this exists

Task #555's unit tests (`tests/redactPostRestoreSweepAlert.test.ts`,
102 assertions) cover the dispatcher contract — recipients trimmed,
body includes the timestamp + per-table counts, channel marked
`succeeded`/`failed` in the outcome — but they stub `sendResendEmail`.

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

A regression in either layer would only surface during an actual
incident — exactly when on-call needs the page to be readable. This
procedure exists so an operator can prove the channel works
end-to-end on staging without waiting for a real database restore to
trigger the boot sweep.

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

## Procedure

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

For the run to count as completed, append a row to the table at the
bottom of this file with:

- The date the run was performed (UTC).
- The dispatcher's exit code from Step 1 (`0` = success).
- A `✅` / `❌` per mail client checked.
- A link to the screenshots folder in this directory.
- The operator's initials.

If any visual check fails, **do not mark the row green** — open a
follow-up task referencing the failure mode (which client, which
checklist item) and link the screenshot.

## Re-run schedule

Re-run this procedure:

- Whenever `dispatchPostRestoreSweepAlert`'s HTML / text body is
  modified (grep for the function name in `git log`).
- Whenever the From domain changes (e.g. switching off
  `onboarding@resend.dev` to a verified custom sender).
- Whenever the recipient-list contract
  (`POST_RESTORE_SWEEP_ALERT_EMAIL` parsing) changes.
- Whenever a major version of Resend's SDK is upgraded.
- At least once per quarter as a baseline freshness check.

## Run log

| Date (UTC) | Counts (EL,NC,CAPA,AI) | Exit | Gmail | Outlook | Apple Mail | Screenshots | Operator |
|------------|------------------------|:----:|:-----:|:-------:|:----------:|-------------|----------|
| _pending first staging run_ | 5,7,11,2 | — | — | — | — | — | — |
