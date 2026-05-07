/**
 * PDPL implementing-regulations fill seed (7 additional articles).
 *
 * Extends the original 18-row PDPL seed in complianceDatabase.ts with
 * codes PDPL-19 through PDPL-25 covering the SDAIA Implementing
 * Regulations (Sept 2023 Royal Decree M/19) that the original seed did
 * not include — primarily breach notification, DPIA triggers, cookies,
 * direct marketing and DPO appointment thresholds.
 *
 * Source: Saudi PDPL Implementing Regulations (Sept 2023). Descriptions
 * are paraphrased summaries — not verbatim regulator text.
 */

import type { Pool } from "pg";
import { runFrameworkSeed, type ObligationDef } from "./obligationSeedTypes";

export const PDPL_FILL_OBLIGATION_DEFINITIONS: ObligationDef[] = [
  {
    code: "PDPL-19",
    clause: "IR Art. 3",
    domain: "Breach Notification",
    order: 19,
    title: "Personal Data Breach Notification to SDAIA",
    desc: "Notify SDAIA within 72 hours of becoming aware of a personal data breach that may cause harm to data subjects, providing the required incident details (nature, scope, affected data, mitigations).",
    type: "mandatory",
    ctrl: "corrective",
    freq: "event_driven",
    priority: "critical",
    dept: "DPO / CISO",
    evidence: "Documented breach register with SDAIA notification timestamps and content.",
  },
  {
    code: "PDPL-20",
    clause: "IR Art. 4",
    domain: "Breach Notification",
    desc: "Notify affected data subjects of personal data breaches likely to result in serious harm, without undue delay.",
    title: "Data Subject Notification of Breach",
    order: 20,
    type: "mandatory",
    ctrl: "corrective",
    freq: "event_driven",
    priority: "critical",
    dept: "DPO / Legal",
    evidence: "Notification template, recipient list per incident.",
  },
  {
    code: "PDPL-21",
    clause: "IR Art. 7",
    domain: "DPIA",
    order: 21,
    title: "Data Protection Impact Assessment Trigger",
    desc: "Conduct a Data Protection Impact Assessment (DPIA) before processing that involves systematic large-scale monitoring, sensitive data, vulnerable subjects, automated decisions with legal effect, or new technology with high privacy risk.",
    type: "mandatory",
    ctrl: "preventive",
    freq: "event_driven",
    priority: "high",
    dept: "DPO",
    evidence: "DPIA template, completed DPIAs per qualifying activity, executive sign-off.",
  },
  {
    code: "PDPL-22",
    clause: "IR Art. 11",
    domain: "Direct Marketing",
    order: 22,
    title: "Direct Marketing Consent",
    desc: "Obtain explicit, informed and revocable consent before sending direct marketing communications; provide a clear opt-out in every message; cease marketing immediately upon opt-out.",
    type: "mandatory",
    ctrl: "preventive",
    freq: "continuous",
    priority: "high",
    dept: "Marketing / DPO",
    evidence: "Consent records, marketing-list opt-out logs, message templates with unsubscribe link.",
  },
  {
    code: "PDPL-23",
    clause: "IR Art. 13",
    domain: "Cookies & Tracking",
    order: 23,
    title: "Cookies and Tracking Technologies",
    desc: "Obtain informed consent before placing non-essential cookies or similar tracking technologies; maintain a cookie register; allow data subjects to manage preferences.",
    type: "mandatory",
    ctrl: "preventive",
    freq: "annual",
    priority: "medium",
    dept: "Web Team / DPO",
    evidence: "Cookie banner implementation, cookie register, preference centre.",
  },
  {
    code: "PDPL-24",
    clause: "IR Art. 16",
    domain: "DPO",
    order: 24,
    title: "Data Protection Officer Appointment",
    desc: "Appoint a Data Protection Officer (DPO) where the controller's core activities involve large-scale processing of personal data, sensitive data, or systematic monitoring; communicate the DPO's contact details to data subjects and SDAIA.",
    type: "mandatory",
    ctrl: "preventive",
    freq: "annual",
    priority: "critical",
    dept: "Executive / DPO",
    evidence: "DPO appointment letter, DPO contact details published, communication to SDAIA.",
  },
  {
    code: "PDPL-25",
    clause: "IR Art. 19",
    domain: "Cross-Border Transfer",
    order: 25,
    title: "Cross-Border Transfer Safeguards",
    desc: "Apply appropriate safeguards (adequacy decision, standard contractual clauses, binding corporate rules) before transferring personal data outside the Kingdom; obtain SDAIA approval where required for sensitive data.",
    type: "mandatory",
    ctrl: "preventive",
    freq: "annual",
    priority: "critical",
    dept: "DPO / Legal",
    evidence: "Transfer impact assessments, SCCs in place, SDAIA approvals on file.",
  },
];

export async function seedPdplFillObligations(pool: Pool): Promise<void> {
  await runFrameworkSeed(
    pool,
    "PDPL",
    PDPL_FILL_OBLIGATION_DEFINITIONS,
    "PDPL Implementing Regulations (fill)",
  );
}
