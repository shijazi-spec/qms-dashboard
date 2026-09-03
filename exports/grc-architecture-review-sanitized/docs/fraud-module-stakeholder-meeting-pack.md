# Fraud Management Module — Stakeholder Alignment Pack (1 page)

**Document ID:** GRQ-PACK-001
**Audience:** Head of GRQ, Quality & GRC Manager, Head of Operations & Quality, Executive sponsor
**Reference docs:** PRD-FRD-001 (Fraud Management Module), GRQ-SOP-001, QMS Integration Brief
**Build status:** Phase 1–4 complete in code; awaiting these 10 sign-offs to lock the v1 release scope
**Author:** QMS Platform team
**Meeting length:** 30 minutes (15 min for PRD corrections, 15 min for decision points)

---

## Part 1 — Five PRD Corrections (please confirm at meeting)

These are **wrong in PRD-FRD-001 v1.0** and have been corrected in code. They do **not** change scope — only file references and role names. Confirm so the next PRD revision (v1.1) can be issued.

| # | PRD Reference | What PRD says (wrong) | What code uses (correct) | Why |
|---|---|---|---|---|
| 1 | §4.1 — Audit Log | `src/utils/auditDatabase.ts` | `src/utils/eventLogsDatabase.ts` | `auditDatabase.ts` is the ISO Audit Programme module. Field-level event logging lives in the partitioned `event_logs` table accessed via `eventLogsDatabase.ts`. |
| 2 | §4.1 + §7 — RBAC role string | `head_of_ops_quality` | `head_of_operations_quality` | Confirmed via the `UserRole` union in `src/utils/rbacDatabase.ts`. The shorter form does not exist anywhere in the platform. |
| 3 | §4.1 — PDF export utility | `src/utils/reportGenerator.ts` | `import("pdfkit")` directly, modeled on `src/mastra/routes/auditRoutes.ts`. Centralized in `src/utils/fraudPdfHelper.ts`. | `reportGenerator.ts` produces print-styled HTML, not PDF. PDFKit is the established pattern for true PDF export across the platform. |
| 4 | §15 Q2 — SMS for P1 | "Open question — SMS in v1?" | **NO** — `NotificationChannel = "in_app" \| "email" \| "ChatProvider"`. SMS is out of scope per §3.2. | No SMS provider exists in the platform; adding TelephonyProvider/Unifonic is a 3-5 day Phase 5 work item. Closes Q2. |
| 5 | §6 — Cross-module link | "Linked to enterprise_risks" but no FK in §5.2 schema | Existing `enterprise_risks.linked_incident_id` column is populated automatically when a P1 or P2 incident is created. Risk row is also auto-mirrored with `risk_category='fraud'`. | The link already existed in the risk schema and is now wired by `createFraudIncident()` in `fraudDatabase.ts`. Zero extra UI work. |

---

## Part 2 — Five Decision Points (Section 15) — Recommendations for Sign-Off

| # | Question | **Recommended Position** | Rationale | Reversal Cost If Overturned |
|---|---|---|---|---|
| 1 | New `fraud_admin` role vs extend existing roles? | **EXTEND** `grc_manager` + `head_of_operations_quality` + `executive`. Add new permission strings only. | Avoids role proliferation. Audit story stays simple. The 8 PRD §7 permissions map cleanly. **Code is built this way.** | Mechanical: add row to `UserRole` union + seed `ROLE_PERMISSIONS`. ~2 hours. |
| 2 | SMS notifications for P1 in v1? | **NO** — defer to Phase 5. | No SMS infra. Email already covers the P1 channel. CEO/Head of GRQ can configure email-to-SMS via their carrier as interim. | New TelephonyProvider/Unifonic integration + secrets + billing + rate limits. ~3-5 days. |
| 3 | Fraud sidebar visible to all roles? | **YES, visible to all authenticated** users; **read-only** for non-fraud roles via API-level RBAC. | Matches existing risks/compliance pattern. Hiding modules creates "shadow" features that are hard to audit. **Code is built this way.** | Remove nav entries via `serveDashboardPageWithRoleGate`. ~30 min. |
| 4 | Auto-seed 17 rules from Excel or manual entry? | **AUTO-SEED** via `seedFraudRules()` (idempotent, ON CONFLICT DO NOTHING). Same pattern as `seedSAMAObligations()`. | Excel is the authoritative source. Manual entry risks data drift during transition. Fully reversible. **Code is built this way.** | Disable seed function and DELETE seeded rows. ~1 hour. |
| 5 | Chargeback: separate incident type or sub-workflow? | **INCIDENT TYPE** (already in PRD §5.2 enum) with dedicated `ESC-CB` row in escalation matrix (`response_sla_hours = 72`). | Sub-workflow doubles UI complexity for a single business case. The 6-row escalation matrix already handles the SLA difference. **Code is built this way.** | Refactor incidents page to add sub-workflow tab. ~5-7 days — only material reversal cost across all 5 questions. |

---

## What the team takes away from this meeting

1. **Sign off (or amend) the 5 corrections** above so PRD v1.1 can be issued and matches the code.
2. **Confirm (or overturn) each of the 5 recommendations.** Q1, Q3, Q4 are already built per recommendation; reversing them is cheap. Q2 is firm (no infra). Q5 is the only one with material code rework if overturned.
3. **Approve UAT kick-off** (Phase 4 — already in code; awaits GRQ team's ~1 week UAT pass against the 5 features).
4. **Schedule one follow-up** (15 min) once GRQ's UAT pass identifies any blocking bugs.

---

## Out of scope for v1 (tracked for Phase 5+)

- SMS / WhatsApp notifications
- HyperPay API direct integration (manual entry only)
- ML-based fraud detection
- FATF API auto-import
- Mobile-responsive incident reporting UI

---

*— End of stakeholder alignment pack —*
