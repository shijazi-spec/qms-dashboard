# HostingPlatform Readiness Checklist (ExampleOrg)

## Executive Status

- **Overall readiness:** Medium-High
- **Core API QC:** Pass (`52/52`)
- **Primary blockers before confident production operation:** secret hygiene, production URL validation from outside HostingPlatform, runbook finalization for incident/rollback.

---

## 1) Done (Verified)

- HostingPlatform runtime and deployment settings are present in `.HostingPlatform`:
  - Node 20, Postgres 16
  - app port 5000
  - autoscale deployment build/run
- HostingPlatform workflows are configured:
  - `Start application`
  - `secret-redaction`
  - `i18n`
  - `post-restore-sweep-panel`
- HostingPlatform-specific integration exists (`src/utils/HostingPlatformmail.ts`) for tokenized HostingPlatform mail flow.
- HostingPlatform dev/prod Inngest architecture is documented in `docs/triggers/dev-prod-HostingPlatform.md`.
- HostingPlatform/Mastra automation constraints are documented in `docs/mastra/00-getting-started/00_HostingPlatform-automations.md`.
- Platform QC suite is in place:
  - `tests/qc/platform-qc-manifest.ts`
  - `tests/qc/run-platform-qc.ts`
  - helper docs under `tests/qc/`
- Latest local QC report is green (`tests/qc/qc-report.md`: **52 pass / 0 fail**).

---

## 2) Open Items (Must Do)

### P0 - Security and Compliance

- Move plaintext secrets out of `.HostingPlatform` and rotate them:
  - `ADMIN_API_KEY`
  - `TEST_ADMIN_KEY`
- Store runtime secrets in HostingPlatform Secrets only.
- Confirm no sensitive credentials are committed anywhere else (`.env`, docs, scripts).

### P1 - Production Reachability Validation

- Re-run QC from outside HostingPlatform against published URL:
  - `QC_BASE_URL=<REDACTED_URL_SCHEME><published-domain> npm run qc`
- If external checks fail while <REDACTED_HOST> passes, treat it as deployment edge/network exposure issue and keep <REDACTED_HOST> report as internal functional truth until publish config is corrected.

### P1 - Release Gate Hardening

- Define a hard release gate: block publish unless all are green:
  - `npm run check`
  - `npm run qc`
  - `secret-redaction` workflow
  - `i18n` workflow
  - `post-restore-sweep-panel` workflow

### P1 - Operations Readiness

- Confirm alert destinations are configured and tested:
  - ChatProvider recipients
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
  - Cause: plaintext keys in `.HostingPlatform`.
  - Mitigation: immediate rotation + secrets manager usage.
- **R2: False-negative production confidence (Medium)**
  - Cause: <REDACTED_HOST> green but published URL may reject external API checks.
  - Mitigation: dual validation (inside HostingPlatform + outside URL) before go-live signoff.
- **R3: Alert blind spots (Medium)**
  - Cause: notification channels not fully smoke-tested in current environment.
  - Mitigation: execute synthetic alert drill and record evidence.

---

## 4) Practical Go/No-Go Criteria

Release should be **Go** only if all are true:

- No plaintext secrets in tracked config.
- Latest local QC: `52/52` pass.
- Published URL QC: no critical endpoint failures (or documented exception with approved mitigation).
- Critical workflows succeed in HostingPlatform.
- Alert test delivery verified.
- Rollback/runbook documented and acknowledged by owners.

---

## 5) Immediate Next 7 Actions (Recommended Sequence)

1. Rotate exposed admin/test keys and migrate to HostingPlatform Secrets.
2. Re-run `npm run qc` internally (<REDACTED_HOST>) and archive report artifact.
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

