# Quality Reports — Phase 3 (Email to Head) — Design Spec

**Date:** 2026-08-06
**Author:** Sarah Hijazi (GRQ) + Claude
**Status:** Approved shape — pending spec review
**Builds on:** Phase 1 + 2 (shipped `f45f14c5`).

## 1. Goal

Let an authorized user **email a BU's Quality Report to that BU's head** — manually, preview-first. No automation, no bulk send. Reuses the existing Resend email helper.

Two send actions from a preview modal: **"Send to \<head\>"** and **"Send test to me"**.

## 2. Safety model (binding)

- **Manual, per-BU, per-action.** A human opens one BU, previews, and clicks Send. Nothing is scheduled or sent in bulk. (Scheduling is explicitly a possible future Phase 3b, NOT this spec.)
- **WYSIWYG preview before send.** The modal shows the EXACT email HTML (fetched from the server) and the recipient, before any send.
- **Server rebuilds the email from live data on send** — it never sends client-supplied HTML (no tampering/injection).
- **Test-to-self targets the authenticated user's OWN email, resolved server-side from the session** — never a client-supplied recipient (so the endpoint can't be used as an open relay).
- **Guards:** if the BU has no `head_email`, the "Send to head" action is disabled/400 with a clear message; if Resend isn't configured (`isResendConfigured()` false), the send fails gracefully with the helper's standard "not configured" message.
- **Audit:** every send logs actor (session user), BU, recipient, mode (head/self), and Resend result id/error.

## 3. Email builder

`buildBUReportEmail(buKey)` (new, in `src/utils/qualityReportsEmail.ts`) → `{ subject: string; html: string; headEmail: string | null; buName: string }`. Composes from `getBUReport(buKey)` (Phase 1 aggregator) + `getBUHeadline(buKey)` if useful:
- **Subject:** `Quality Report — <BU name> — <YYYY-MM-DD>` (date passed in by the caller/route, since the codebase forbids `new Date()` in some contexts — the route stamps it and passes it; the builder takes a `dateISO` param).
- **HTML:** an email-friendly digest — **INLINE styles are REQUIRED here** (email clients strip `<style>`/classes; this is EMAIL HTML, a different context from the CSP-constrained dashboard page — do NOT apply the dashboard's no-inline-style rule to the email body). Simple table/`<div>` layout, safe fonts/colors inline. Sections: header (BU name, channel, date), then per section: SOPs (count or "not configured"), KPIs (%), Cleanup (verified merges / outstanding), Compliance (CS/stage-aging/deal-docs), Open actions (open CAPAs). Sections in `notConfigured` render "Not configured yet." All dynamic values HTML-escaped.
- `headEmail` = the BU's `head_email` (may be null).
- Returns `null` when the BU doesn't exist (route → 404).

Signature: `buildBUReportEmail(buKey: string, dateISO: string): Promise<{ subject: string; html: string; headEmail: string | null; buName: string } | null>`.

## 4. Endpoints (in `qualityReportsRoutes.ts`)

- `GET /api/quality-reports/bus/:buKey/email-preview` (READ_ROLES) → `{ success, subject, html, headEmail, buName }` (404 if BU unknown). The route stamps the date and calls `buildBUReportEmail`. Used by the preview modal.
- `POST /api/quality-reports/bus/:buKey/email` (WRITE_ROLES) — body `{ mode: "head" | "self" }`:
  - Rebuild via `buildBUReportEmail(buKey, <route date>)` (404 if unknown).
  - `mode==="head"`: `to = built.headEmail`; if falsy → 400 `{error:"This BU has no head email mapped."}`.
  - `mode==="self"`: `to = <authenticated user's email from the session>` (resolve from the session `user` object server-side; if unavailable → 400 `{error:"Could not resolve your email."}`). NEVER read the recipient from the request body.
  - Send: `await sendResendEmail({ to, subject: built.subject, html: built.html })` (import from `src/utils/resendMail.ts`). Return `{ success, id?, error? }` mirroring the helper (surface the helper's `error` string, which is already user-safe — e.g. the "not configured" message).
  - Audit-log: `logger.info("[QualityReports] email sent", { actor, buKey, to, mode, resendId, ok })`.
- **RBAC:** add two allowlist entries (the existing `/bus/[^/]+$` and `/bus/[^/]+/summary$` rules don't match these):
  - `{ pattern: /^\/api\/quality-reports\/bus\/[^/]+\/email-preview$/, methods:["GET"], roles: <READ_ROLES> }`
  - `{ pattern: /^\/api\/quality-reports\/bus\/[^/]+\/email$/, methods:["POST"], roles: <WRITE_ROLES> }`

## 5. Frontend (`dashboard/quality-reports.html` + `quality-reports.js`, bump `?v=3`→`?v=4`)

- On the BU page, an **"✉ Email to head"** button. Disabled with a hint when `bu.head_email` is empty ("Map a head email in settings first"). (The BU page already has `d.bu.head_email` from `GET /bus/:buKey`.)
- Clicking it: `GET …/email-preview`, then open a **modal** rendering the returned email `html` inside a **sandboxed `<iframe srcdoc=...>`** (isolates the email's inline styles from the dashboard; safe display of our own generated HTML). Show the recipient line ("To: <head_email>"). Buttons: **Send to \<head\>**, **Send test to me**, **Cancel**.
- **Send to head:** `POST …/email {mode:"head"}` → on `success` toast "Sent to <head>"; on failure toast the returned `error`. Disable the button while in flight.
- **Send test to me:** `POST …/email {mode:"self"}` → toast "Test sent to you".
- CSP: the modal/button markup uses classes only (dashboard context); the iframe `srcdoc` carries the email HTML (inline styles there are fine — it's an isolated document). Dynamic text via `escapeHtml`.

## 6. Non-goals
- No scheduling / recurring / automated sends (possible Phase 3b).
- No "email all BUs" bulk action.
- No editing the email body in-app (it's generated; test-to-self covers eyeballing it).

## 7. Testing
- `buildBUReportEmail` pure-ish shaping: split the HTML assembly into a testable pure function `renderBUReportEmailHtml(report, dateISO)` taking a `BUReport`-shaped object → asserts subject/date, escaping, "Not configured yet" for null sections, "no deals checked yet" for deal-docs checked=0. Executed via tsc-CJS-emit (vitest can't run locally).
- Route + send: `tsc --noEmit` + reading; mocked-pool/mocked-`sendResendEmail` vitest asserting `mode:"self"` ignores any body-supplied `to` and uses the session email, and `mode:"head"` 400s when headEmail null.
- `check-dashboard-html-js.mjs`, `node --check`, `tsc -p tsconfig.tests.json` clean.
- Manual (post-republish): preview renders; "Send test to me" arrives in Sarah's inbox; "Send to head" works when a head_email is mapped and 400s cleanly when not.

## 8. Deployment
Commit only touched files; push `origin/QMS`; bump `quality-reports.js?v=3`→`?v=4`; user Pulls → Republishes. No schema changes. Requires `RESEND_API_KEY` (already set for the existing email features) and optionally `RESEND_FROM_EMAIL`.
