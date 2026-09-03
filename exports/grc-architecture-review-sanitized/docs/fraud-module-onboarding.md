# Fraud Management Module — Onboarding Checklist (Phase 1)

**Audience:** GRQ team (Head of GRQ, GRQ Analyst), Quality & GRC Manager
**Purpose:** Upload the source-of-truth fraud documents into the QMS as controlled documents BEFORE Phase 2 development begins.
**Owner:** Head of GRQ
**Effort:** ~30 minutes one-time
**Related:** PRD-FRD-001, GRQ-SOP-001

---

## Why this matters

The fraud module's code (Phase 2 onwards) auto-seeds the platform database from the Excel workbook (17 fraud rules, 20 country risk entries, 6 escalation matrix rows). Before that seeding becomes the single source of truth, the original Excel + SOP + PRD must be in the QMS document register so that:

1. Auditors can trace the seed data back to a controlled, versioned source document.
2. Any future correction to the rules/countries/matrix follows the QMS change-control process (not ad-hoc edits to seed code).
3. The interim Excel workflow described in GRQ-SOP-001 stays operational and auditable while the module is being built.

---

## Step-by-step checklist

### Documents to upload

Upload all four documents listed below as **controlled documents** in the QMS document register.

| # | Source file | Document ID | Owner | Version | Review Date | Linked Documents |
|---|---|---|---|---|---|---|
| 1 | `ExampleOrg-Fraud-Management-Operational-Registers.xlsx` | GRQ-REG-001 | Head of GRQ | v1.0 | 2027-04-29 | GRQ-SOP-001 |
| 2 | `GRQ-SOP-001-Fraud-Registers-Operating-Procedure.docx` | GRQ-SOP-001 | Head of GRQ | v1.0 | 2027-04-29 | GRQ-FWK-005, GRQ-POL-010, GRQ-PROC-007 |
| 3 | `PRD-FRD-001-Fraud-Management-Module.md` | PRD-FRD-001 | QMS Platform Owner | v1.0 | <REDACTED_PHONE>-month review) | GRQ-SOP-001 |
| 4 | `QMS-Platform-Integration-Brief-Fraud-Module.docx` | GRQ-BRF-001 | Head of GRQ | v1.0 | <REDACTED_PHONE>-month review) | PRD-FRD-001 |

### Per-document checklist (repeat for each of the 4 above)

- [ ] Open the QMS Documents page in the platform.
- [ ] Click **Upload New Document**.
- [ ] Select the source file from your local machine.
- [ ] Set **Document ID** exactly as listed in the table above.
- [ ] Set **Title** to the full document title (not the filename).
- [ ] Set **Classification** = `Internal — Confidential`.
- [ ] Set **Owner** as listed.
- [ ] Set **Version** = `v1.0`.
- [ ] Set **Effective Date** = `2026-04-29`.
- [ ] Set **Review Date** as listed.
- [ ] In the **Linked Documents** field, link to the parent documents listed.
- [ ] Confirm version tracking is enabled (default for controlled documents — should not need to be toggled).
- [ ] Save and verify the document appears in the controlled-documents register with all metadata correct.

### Parent documents (verify they exist; create stubs if missing)

The four documents above link to the following parents. If any do not yet exist in QMS, create a placeholder entry so the link resolves. The actual content can be filled in later by the document owner.

- GRQ-FWK-005 — Fraud Management Framework (owner: Head of GRQ)
- GRQ-POL-010 — Fraud Prevention Policy (owner: Head of GRQ)
- GRQ-PROC-007 — Fraud Incident Response Procedure (owner: Head of GRQ)

### Review reminders

- [ ] After upload, set the platform-side review reminder for each document (this is automatic if the QMS document module supports cron-based review notifications). Otherwise, calendar-block the dates in your team calendar.

---

## What happens after Phase 1

Once these four documents are in QMS:

1. The **Excel workbook stays operational** — GRQ continues using it to log incidents and update rules until Phase 2 ships (estimated 2-3 weeks for Feature 1 + 2).
2. The QMS Platform team begins **Phase 2 — Feature 1 (Fraud Rules Register)**, which will auto-seed the platform DB from the Excel data. The Excel becomes the historical source-of-truth; the platform becomes the live operational tool.
3. The **30-minute alignment meeting** (referenced in your original brief) confirms the 5 PRD decision-point recommendations (see `Stakeholder Meeting Pack` produced at the end of the build).

---

## Issues / questions during upload

If you hit any blockers (document ID conflicts, missing parent documents, permission issues), log them in your normal QMS team channel and flag the platform team. Do NOT change document IDs to work around conflicts — those IDs are referenced by code that auto-links to them.

---

*— End of Phase 1 checklist —*
