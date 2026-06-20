/**
 * Hygiene & business rules catalog — the canonical, human-readable list of the
 * data-hygiene / governance rules the GRQ team agreed on while building each
 * Duplicate Radar tab. Surfaced read-only (and per-module-selectable) on the
 * Adam — Scope of Work screen (GET /api/duplicates/hygiene-rules) so Sarah can
 * review the rules tab-by-tab and flag anything that needs editing.
 *
 * Organised PER TAB/MODULE so it mirrors the Duplicate Radar tabs. Groups
 * flagged `general: true` are cross-cutting (shown alongside any selected tab).
 *
 * This is a REFERENCE list (not the resolver's executable "learning rules").
 * Keep it in sync with the rules block in qmsConsultantAgent.ts as standing
 * rules are agreed.
 */

export interface HygieneRule {
  id: string;
  rule: string;
  /** Where it's enforced / its source of truth. */
  ref?: string;
}

export interface HygieneRuleGroup {
  /** Matches a Duplicate Radar tab id (or a cross-cutting area). */
  key: string;
  title: string;
  /** Cross-cutting — show with every selected tab. */
  general?: boolean;
  rules: HygieneRule[];
}

export const HYGIENE_RULES_CATALOG: HygieneRuleGroup[] = [
  // ── Cross-cutting (always shown) ───────────────────────────────────────────
  {
    key: "general",
    title: "General (applies to every tab)",
    general: true,
    rules: [
      { id: "gen-scope", rule: "CORPORATE / B2B company records only. Marketplace & Merchant records are out of scope. A record is corporate unless it carries an explicit merchant layout (Marketplace, Partner Accounts).", ref: "Sarah 2026-06-17" },
      { id: "gen-freemail", rule: "Free-mail domains (gmail, yahoo, ymail, hotmail, outlook…) and WalaPlus house domains are NOT a clustering signal. Placeholder names (N/A, Not Provided…) go to a quarantine bucket, not a real duplicate." },
      { id: "gen-migrate-tag", rule: "Merge = migrate-then-tag: keep the survivor, copy its MISSING fields from the duplicate(s), tag the duplicate(s) 'Duplicate-Delete'. The platform NEVER deletes — the admin deletes tagged records." },
      { id: "gen-resolved-merged", rule: "'Resolved' ≠ 'Merged'. A cluster is only truly resolved once tagged records are confirmed deleted in Zoho. Report the real applied/merged figure, never the cluster 'resolved' count." },
      { id: "gen-hitl", rule: "Every Zoho write is gated (Human-in-the-Loop): it queues for approval (admin password) before applying. Attribution: 'Adam — GRQ Assistant (on behalf of Sarah Hijazi)'. Shadow default = no autonomous writes; kill switch always live." },
      { id: "gen-safe-tier", rule: "Safe-tier auto-apply requires ALL clear: confidence ≥85, <2 domains, <2 phones, no CS block/review, pipeline & ARR ≤ cap, no active deal stage, 0 field conflicts, all Zoho ids present, not cross-module, <2 layouts, ≤1 owner, nothing modified <7 days, no failed prior verification, no custom-field assumption, survivor ≥50% complete, no attachments. Any one missing → escalate." },
    ],
  },
  // ── Per-module duplicate tabs ──────────────────────────────────────────────
  {
    key: "accounts",
    title: "Accounts Duplicates",
    rules: [
      { id: "acc-def", rule: "A duplicate Account = the SAME company — same domain / legal name / close fuzzy name." },
      { id: "acc-survivor", rule: "Survivor = the most complete record / the one with the Account + most related records; gap-fill its blanks, tag the others Duplicate-Delete." },
    ],
  },
  {
    key: "contacts",
    title: "Contacts Duplicates",
    rules: [
      { id: "con-def", rule: "A duplicate Contact = the SAME person — only when ≥2 of {email, phone, full name} match. Sharing an Account is NOT duplicate evidence (that's the Account-merge cascade).", ref: "hard rule" },
    ],
  },
  {
    key: "leads",
    title: "Leads Duplicates",
    rules: [
      { id: "lead-def", rule: "Duplicate leads are ACCEPTED. A lead is only flagged when the SAME lead (same phone + email) is submitted AGAIN (a resubmission)." },
    ],
  },
  {
    key: "deals",
    title: "Deals Duplicates",
    rules: [
      { id: "deal-def", rule: "The problem is 2 ACTIVE deals for the same thing → tag Duplicate-Delete + merge info. Won / closed / lost deals are NOT duplicates to fix (detection is stage-aware)." },
    ],
  },
  // ── Cross-module & lifecycle tabs ──────────────────────────────────────────
  {
    key: "cross-module",
    title: "Cross-Module Overlap",
    rules: [
      { id: "xm-lead", rule: "Lead ↔ anything: Zoho can't link a Lead — fix is CLOSE the Lead (convert into the existing Account or close as duplicate). Pure Lead↔Contact / Lead↔Account clusters are hidden here (handled on the Leads tab).", ref: "Sarah 2026-06-16" },
      { id: "xm-link", rule: "Contact ↔ Account / Deal ↔ Account → LINK by Account_Name. Contact ↔ Deal → LINK by Contact_Name. 3+ modules → open the cluster for per-record recs." },
      { id: "xm-existing-client", rule: "Existing-client flag only when a Deal in Paid / Agreement Signed / Closed Won / Awaiting PO / Client Activated / Transferred to CS is present (CS-owned). A Contact alone is NOT customer evidence." },
    ],
  },
  {
    key: "cs-lifecycle",
    title: "CS Lifecycle",
    rules: [
      { id: "cs-phases", rule: "CS deals by phase (onboarding / adoption / renewal / termination). Violations: onboarding_overdue (>30d), adoption_premature (trial still open), renewal_overdue (CRITICAL past a quarter / 90d), termination_missing_churn_date, termination_missing_churn_reason, + active-phase missing-field checks." },
    ],
  },
  {
    key: "cs-overlap",
    title: "CS Pipeline Overlap",
    rules: [
      { id: "cso-block", rule: "BLOCK when an OPEN Sales Deal + a Paid/Agreement-Signed handoff Deal coexist on the same customer AND the churn cool-off has NOT elapsed (180d Private / 365d Government). WARN if past cool-off in Termination. A lone Paid deal in Adoption is not flagged.", ref: "Sarah 2026-06-11" },
    ],
  },
  {
    key: "deals-lifecycle",
    title: "Deals Lifecycle (stage aging)",
    rules: [
      { id: "dl-slas", rule: "Stage SLAs (Sales SOP v1.1): Not Attend Meeting ≤5 business days (§7.2.8); Meeting ≤10 business days (§7.3); On Hold 3–6 months (§7.3.11); Proposal ≤3 months (§7.4.2); Agreement Sent ≤3 months (§7.5.1). WARNING past SLA up to 1.5×; CRITICAL past 1.5×. Terminal stages freeze aging." },
    ],
  },
  {
    key: "deal-compliance",
    title: "Deal Compliance (documents)",
    rules: [
      { id: "dc-docs", rule: "Sales SOP 7.5.10, ATTACHMENTS only: Proposal needs the financial offer; Agreement Signed & Paid need proposal + contract/PO + VAT cert + Commercial Registration + National Address. (Field-level data-entry compliance lives on the Quality Dashboard audit.)" },
    ],
  },
  {
    key: "account-hints",
    title: "Account Hints",
    rules: [
      { id: "ah-conf", rule: "Smart Account inference for Deals missing Account_Name: confidence = 40 base + evidence (cap 100); AI auto-resolve gate 70%. Dismissed hints are immutable (never resurrected by a re-scan)." },
    ],
  },
  {
    key: "preflight",
    title: "Preflight Check",
    rules: [
      { id: "pf-basic", rule: "ACTIVE = BASIC: Rule 1 — contact dup by email/phone → 'duplicate'. Rule 2 (only if no dup) — domain has a signed/paid not-churned deal → 'block'. Else 'pass'. Fallback: domain → phone (≥7 digits) → company-name fuzzy.", ref: "Ahmad 2026-06-18" },
      { id: "pf-active-lead", rule: "Reject a vendor/import row when an ACTIVE Lead already exists for that corporate cluster — pass info to the existing owner, do NOT re-import." },
      { id: "pf-closed-lost", rule: "Closed-Lost-only on file is NOT a duplicate — Sales may re-engage; LINK the new lead to the existing Account (LOW)." },
    ],
  },
  {
    key: "owner-accountability",
    title: "Owner Accountability",
    rules: [
      { id: "oa-rag", rule: "Duplicate-rate RAG (SDR-KPI-09): green ≤2%, amber 2–5%, red >5%. Reps on multiple mailboxes consolidate under their canonical email (OWNER_EMAIL_ALIASES)." },
    ],
  },
  {
    key: "cluster-merge",
    title: "Cluster Merge",
    rules: [
      { id: "cm-split", rule: "Finds domains with ≥2 separate clusters (same-domain split from concurrent syncs). Recommended master = the cluster with an Account + highest record count + highest confidence." },
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
