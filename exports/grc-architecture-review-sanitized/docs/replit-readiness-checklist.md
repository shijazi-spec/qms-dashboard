# Replit Readiness Checklist (ExampleOrg)

## Executive Status

- **Overall readiness:** Medium-High
- **Core API QC:** Pass (`52/52`)
- **Primary blockers before confident production operation:** secret hygiene, production URL validation from outside Replit, runbook finalization for incident/rollback.

---

## 1) Done (Verified)

- Replit runtime and deployment settings are present in `.replit`:
  - Node 20, Postgres 16
  - app port 5000
  - autoscale deployment build/run
- Replit workflows are configured:
  - `Start application`
  - `secret-redaction`
  - `i18n`
  - `post-restore-sweep-panel`
- Replit-specific integration exists (`src/utils/replitmail.ts`) for tokenized Replit mail flow.
- Replit dev/prod Inngest architecture is documented in `docs/triggers/dev-prod-replit.md`.
- Replit/Mastra automation constraints are documented in `docs/mastra/00-getting-started/00_replit-automations.md`.
- Platform QC suite is in place:
  - `tests/qc/platform-qc-manifest.ts`
  - `tests/qc/run-platform-qc.ts`
  - helper docs under `tests/qc/`
- Latest local QC report is green (`tests/qc/qc-report.md`: **52 pass / 0 fail**).

---

## 2) Open Items (Must Do)

### P0 - Security and Compliance

- Move plaintext secrets out of `.replit` and rotate them:
  - `ADMIN_API_KEY`
  - `TEST_ADMIN_KEY`
- Store runtime secrets in Replit Secrets only.
- Confirm no sensitive credentials are committed anywhere else (`.env`, docs, scripts).

### P1 - Production Reachability Validation

- Re-run QC from outside Replit against published URL:
  - `QC_BASE_URL=https://<published-domain> npm run qc`
- If external checks fail while localhost passes, treat it as deployment edge/network exposure issue and keep localhost report as internal functional truth until publish config is corrected.

### P1 - Release Gate Hardening

- Define a hard release gate: block publish unless all are green:
  - `npm run check`
  - `npm run qc`
  - `secret-redaction` workflow
  - `i18n` workflow
  - `post-restore-sweep-panel` workflow

### P1 - Operations Readiness

- Confirm alert destinations are configured and tested:
  - Slack recipients
  - email recipients
- Run one synthetic alert path test and verify delivery state appears in AI Ops surfaces.

### P2 - Runbook Finalization

- Publish one-page operational runbook for:
  - incident triage
  - rollback
  - failed workflow recovery
  - credential rotation steps

---

## 3) Risk Register

- **R1: Secret exposure risk (High)**
  - Cause: plaintext keys in `.replit`.
  - Mitigation: immediate rotation + secrets manager usage.
- **R2: False-negative production confidence (Medium)**
  - Cause: localhost green but published URL may reject external API checks.
  - Mitigation: dual validation (inside Replit + outside URL) before go-live signoff.
- **R3: Alert blind spots (Medium)**
  - Cause: notification channels not fully smoke-tested in current environment.
  - Mitigation: execute synthetic alert drill and record evidence.

---

## 4) Practical Go/No-Go Criteria

Release should be **Go** only if all are true:

- No plaintext secrets in tracked config.
- Latest local QC: `52/52` pass.
- Published URL QC: no critical endpoint failures (or documented exception with approved mitigation).
- Critical workflows succeed in Replit.
- Alert test delivery verified.
- Rollback/runbook documented and acknowledged by owners.

---

## 5) Immediate Next 7 Actions (Recommended Sequence)

1. Rotate exposed admin/test keys and migrate to Replit Secrets.
2. Re-run `npm run qc` internally (localhost) and archive report artifact.
3. Run QC against published URL and compare deltas.
4. Execute `secret-redaction` workflow and capture output.
5. Execute `i18n` + `post-restore-sweep-panel` workflows and capture output.
6. Trigger one synthetic operational alert and verify notifications + dashboard status.
7. Approve final go/no-go using criteria above.

---

## 6) Ownership Template (Fill In)

- **Platform owner:** `<name>`
- **Security owner:** `<name>`
- **Release approver:** `<name>`
- **Operations/on-call owner:** `<name>`
- **Target release date:** `<date>`

