/**
 * Hygiene & business rules catalog — the canonical, human-readable list of the
 * data-hygiene / governance rules the GRQ team has agreed on and that Adam +
 * the Duplicate Radar enforce. Surfaced read-only on the Autonomous Resolution
 * screen (GET /api/duplicates/hygiene-rules) so an operator can see, in ONE
 * place, exactly what the agent is checking before deciding whether to trust it
 * in assisted mode.
 *
 * This is a REFERENCE list (not the resolver's executable "learning rules",
 * which live in duplicate_resolution_rules). Keep it in sync as new standing
 * rules are agreed — it mirrors the rules block in qmsConsultantAgent.ts.
 */

export interface HygieneRule {
  id: string;
  rule: string;
  /** Where it's enforced / its source of truth. */
  ref?: string;
}

export interface HygieneRuleGroup {
  key: string;
  title: string;
  rules: HygieneRule[];
}

export const HYGIENE_RULES_CATALOG: HygieneRuleGroup[] = [
  {
    key: "scope",
    title: "Scope",
    rules: [
      {
        id: "scope-corporate",
        rule: "All Duplicate Radar rules apply to CORPORATE / B2B company records only. Marketplace and Merchant records are out of scope (different sales motion). A record is corporate unless it carries an explicit merchant layout (Marketplace, Partner Accounts).",
        ref: "Sarah 2026-06-17",
      },
    ],
  },
  {
    key: "duplicates",
    title: "Per-module duplicate definitions",
    rules: [
      { id: "dup-accounts", rule: "Accounts: the SAME company — same domain / legal name / close fuzzy name." },
      { id: "dup-contacts", rule: "Contacts: the SAME person — only a duplicate when ≥2 of {email, phone, full name} match. Sharing an Account is NOT duplicate evidence." },
      { id: "dup-leads", rule: "Leads: duplicate leads are accepted; a lead is only flagged when the SAME lead (same phone + email) is submitted AGAIN (a resubmission)." },
      { id: "dup-deals", rule: "Deals: the problem is 2 ACTIVE deals for the same thing. Won/closed/lost deals are not duplicates to fix." },
      { id: "dup-freemail", rule: "Free-mail (gmail, yahoo, ymail, hotmail, outlook…) and WalaPlus house domains are NOT a clustering signal. Placeholder names (N/A, Not Provided…) go to a quarantine bucket, not a real duplicate." },
    ],
  },
  {
    key: "resolution",
    title: "Resolution & merge",
    rules: [
      { id: "res-migrate-tag", rule: "Merge = migrate-then-tag: keep the survivor, copy the survivor's MISSING fields from the duplicate(s), tag the duplicate(s) 'Duplicate-Delete'. The platform NEVER deletes — the admin deletes tagged records." },
      { id: "res-resolved-vs-merged", rule: "'Resolved' ≠ 'Merged'. A cluster is only truly resolved once tagged records are confirmed deleted in Zoho (Verify in CRM). Report the real 'applied/merged' figure, never the cluster 'resolved' count." },
      { id: "res-safe-tier", rule: "Safe-tier (auto-apply in assisted) requires ALL clear: confidence ≥85, <2 domains, <2 phones, no CS block/review, pipeline & ARR ≤ cap (default 0), no active deal stage, 0 field conflicts, all Zoho ids present, not cross-module, <2 layouts, ≤1 owner, nothing modified <7 days, no failed prior verification, no custom-field assumption, survivor ≥50% complete, no attachments on duplicates. Any one missing → escalate." },
      { id: "res-dont-reask", rule: "Your decisions stick: a cluster you reject is not re-proposed for 30 days; a pending cluster is never re-queued. A bulk Clear is a reset, not a rejection." },
    ],
  },
  {
    key: "cross-module",
    title: "Cross-module overlap",
    rules: [
      { id: "xm-lead", rule: "Lead ↔ anything: Zoho can't link a Lead, so the fix is CLOSE the Lead (convert into the existing Account or close as duplicate) — never 'link the lead'." },
      { id: "xm-link", rule: "Contact ↔ Account / Deal ↔ Account → LINK by setting Account_Name. Contact ↔ Deal → LINK by setting Contact_Name." },
      { id: "xm-existing-client", rule: "Existing-client flag only when a Deal in Paid / Agreement Signed / Closed Won / Awaiting PO / Client Activated / Transferred to CS is present — those are CS-owned; Sales must not pursue. A Contact alone is NOT customer evidence." },
    ],
  },
  {
    key: "cs-lifecycle",
    title: "CS Lifecycle (per-phase hygiene)",
    rules: [
      { id: "cs-phases", rule: "CS deals tracked by phase: onboarding / adoption / renewal / termination. Violations: onboarding_overdue (>30 days), adoption_premature (trial still open), renewal_overdue (CRITICAL past a quarter / 90 days), termination_missing_churn_date, termination_missing_churn_reason, plus active-phase missing-field checks (company_domain, customer_since, renewal_date, health_score, arr_value)." },
      { id: "cs-overlap", rule: "CS Pipeline Overlap: BLOCK when an OPEN Sales Deal + a Paid/Agreement-Signed handoff Deal coexist on the same customer AND the churn cool-off has NOT elapsed (180d Private / 365d Government); WARN if past cool-off in Termination; otherwise no flag." },
    ],
  },
  {
    key: "deals-lifecycle",
    title: "Deals Lifecycle (Sales SOP stage aging)",
    rules: [
      { id: "deal-slas", rule: "Stage SLAs (Sales SOP v1.1): Not Attend Meeting ≤5 business days (§7.2.8); Meeting ≤10 business days (§7.3); On Hold 3–6 months (§7.3.11); Proposal ≤3 months (§7.4.2); Agreement Sent ≤3 months (§7.5.1). WARNING past SLA up to 1.5×; CRITICAL past 1.5×. Terminal stages (Agreement Signed, Paid, Closed Won/Lost) freeze aging." },
      { id: "deal-compliance", rule: "Deal document compliance (Sales SOP 7.5.10, attachments only): Proposal needs the financial offer; Agreement Signed & Paid need proposal + contract/PO + VAT cert + Commercial Registration + National Address." },
    ],
  },
  {
    key: "preflight",
    title: "Preflight (vetting a new record)",
    rules: [
      { id: "pf-basic", rule: "ACTIVE mode = BASIC: Rule 1 — contact duplicate by email/phone → 'duplicate'. Rule 2 (only if no dup) — domain has a signed/paid, not-churned deal → 'block'. Else 'pass'. Identity fallback: domain → phone (≥7 digits) → company-name fuzzy." },
      { id: "pf-active-lead", rule: "Reject a vendor/import row when an ACTIVE Lead already exists for that corporate cluster — pass the info to the existing owner; do NOT re-import." },
      { id: "pf-closed-lost", rule: "A prior Closed-Lost-only deal is NOT a duplicate — Sales may re-engage; LINK the new lead to the existing Account (severity LOW)." },
    ],
  },
  {
    key: "ownership",
    title: "Owner accountability",
    rules: [
      { id: "own-rag", rule: "Duplicate-rate RAG (SDR-KPI-09): green ≤2%, amber 2–5%, red >5%. Reps on multiple mailboxes consolidate under their canonical email (OWNER_EMAIL_ALIASES)." },
    ],
  },
  {
    key: "governance",
    title: "Governance & attribution",
    rules: [
      { id: "gov-hitl", rule: "Every Zoho write is gated (Human-in-the-Loop): it queues for approval (admin password) before it is applied. The agent never deletes; risky tiers always need a human." },
      { id: "gov-attribution", rule: "Agent actions are attributed 'Adam — GRQ Assistant (on behalf of Sarah Hijazi)' for ISO 27001 non-repudiation. Kill switch + shadow mode default = no autonomous writes until a manager promotes the mode." },
    ],
  },
];

export function getHygieneRulesCatalog(): {
  groups: HygieneRuleGroup[];
  totalRules: number;
} {
  return {
    groups: HYGIENE_RULES_CATALOG,
    totalRules: HYGIENE_RULES_CATALOG.reduce((n, g) => n + g.rules.length, 0),
  };
}
