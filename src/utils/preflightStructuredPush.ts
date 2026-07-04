export const PREFLIGHT_DEAL_TARGET = {
  layoutId: process.env.PREFLIGHT_DEAL_LAYOUT_ID || "5146753000000091023",
  pipeline: process.env.PREFLIGHT_DEAL_PIPELINE || "Standard (Corporates)",
  stage: process.env.PREFLIGHT_DEAL_STAGE || "New Deal",
};
export const PREFLIGHT_LEAD_TARGET = {
  layoutId: process.env.PREFLIGHT_LEAD_LAYOUT_ID || "5146753000000091055",
  status: process.env.PREFLIGHT_LEAD_STATUS || "New Lead",
};

// The Lead/Deal layouts make "Products" a required multi-select — stamp this
// value on every pushed Lead and Deal. Env-overridable; empty string omits it.
// Sent as an array (multi-select picklist format): ["WalaPlus"].
export const PREFLIGHT_PRODUCT = process.env.PREFLIGHT_PRODUCT ?? "WalaPlus";

// Other required fields the import can't source: No. of Employees defaults to
// 0 (the sales agent updates it after), and Sales Person defaults to a user
// resolved by email. Both env-overridable.
export const PREFLIGHT_EMPLOYEES = Number(process.env.PREFLIGHT_EMPLOYEES ?? 0) || 0;
export const PREFLIGHT_SALESPERSON_EMAIL = process.env.PREFLIGHT_SALESPERSON_EMAIL || "client@walaplus.com";
// Gov Type picklist — set to "Private" for the whole batch for now.
export const PREFLIGHT_GOV_TYPE = process.env.PREFLIGHT_GOV_TYPE ?? "Private";
// CS Member — a plain TEXT (name) field, normally populated from the CS
// platform, but enforced as mandatory on Deal create here. Stamp a placeholder
// NAME the CS team can reassign. Sent as a STRING (not a user lookup). Empty
// string omits it.
export const PREFLIGHT_CS_MEMBER = process.env.PREFLIGHT_CS_MEMBER ?? "WalaPlus";

// Lead_Source stamped on EVERY record the push creates (Leads, Contacts, Deals).
// Ahmad 2026-07-01: all Preflight-pushed records carry Lead_Source = "Mawsool".
// Env-overridable so a future batch/source can change it without a code change.
export const PREFLIGHT_LEAD_SOURCE = process.env.PREFLIGHT_LEAD_SOURCE || "Mawsool";

// Zoho Tags applied to pushed records (the tags already exist in the CRM).
// Leads → "Mawsool"; Deals → "Mawsool/Sales". Env-overridable. Contacts get
// no tag (not requested). Empty string disables tagging for that module.
export const PREFLIGHT_LEAD_TAG = process.env.PREFLIGHT_LEAD_TAG ?? "Mawsool";
export const PREFLIGHT_DEAL_TAG = process.env.PREFLIGHT_DEAL_TAG ?? "Mawsool/Sales";

// ---------------------------------------------------------------------------
// Task 2: Pure planner — no Zoho, no DB
// ---------------------------------------------------------------------------

export interface SPRow {
  row_index: number;
  company: string;
  domain: string;
  email: string;
  phone: string;
  contact_name: string;
  title: string;
  verdict: string;
  cluster_id: number | null;
  matched_account_zoho_id: string | null;
  matched_account_name?: string | null;
  lifecycle_state: string | null;
}

export interface SPCompany {
  companyKey: string;
  companyName: string;
  domain: string;
  clusterId: number | null;
  contacts: SPRow[];
}

export interface StructuredPushPlan {
  action: 1 | 2 | 3 | 4;
  companies: SPCompany[];   // for 1/2/3 — one entry per company (one Account+Deal)
  leads: SPRow[];           // for 4 — one entry per row
  eligible_count: number;   // companies (1/2/3) or leads (4)
  contact_count: number;    // total contacts across companies (1/2/3) or = leads.length (4)
  skipped: Array<{ row_index: number; reason: string }>;
}

export function normalizeCompanyKey(company: string, domain: string): string {
  return String(company || domain || "").trim().toLowerCase();
}

// Free-mail providers + placeholder tokens that must NEVER be written as an
// Account/Lead Website. The Mawsool export uses "#n" for "no domain" and bare
// free-mail tokens ("gmail", "hotmail") for personal-email contacts — writing
// "https://#n" or "https://gmail" would pollute ~half the new records.
const FREE_MAIL_OR_PLACEHOLDER = new Set([
  "#n", "n/a", "na", "none", "null", "unknown",
  "gmail", "hotmail", "yahoo", "outlook", "icloud", "aol", "live", "msn", "proton", "protonmail", "hotmai", "gmai",
  "gmail.com", "hotmail.com", "yahoo.com", "outlook.com", "icloud.com", "aol.com", "live.com", "msn.com", "protonmail.com", "proton.me",
]);

// realDomainRoot — pure. Normalizes a domain-ish value (a raw domain, a URL,
// or an email address) to its bare REAL domain, or null for
// blank/placeholder/free-mail values. A real domain must be dotted with a
// plausible TLD and not a known free-mail provider. This is the single source
// of truth for "is this a verifiable company domain?" used by both the
// Website writer and the contact router.
export function realDomainRoot(value: string | null | undefined): string | null {
  let d = String(value || "").trim().toLowerCase();
  if (!d) return null;
  d = d.replace(/^https?:\/\//, "").replace(/\/.*$/, "");   // strip scheme/path
  d = d.split("@").pop() || d;                               // strip any local-part
  d = d.replace(/\.$/, "");                                  // strip trailing dot
  if (!d || FREE_MAIL_OR_PLACEHOLDER.has(d)) return null;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) return null;   // needs a dotted TLD
  return d;
}

// websiteFromDomain — pure. Returns a clean https:// URL for a REAL company
// domain, or null for blank/placeholder/free-mail domains (must not be written
// to the CRM).
export function websiteFromDomain(domain: string | null | undefined): string | null {
  const root = realDomainRoot(domain);
  return root ? `https://${root}` : null;
}

// ---------------------------------------------------------------------------
// Fuzzy company-identity helpers — used ONLY to FLAG a lead/new-deal as a
// "possible existing client" for human verification (never to auto-link; that
// stays on exact matches). Keeps the sales team from cold-contacting an active
// client whose contact used a personal email or a slightly different name.
// ---------------------------------------------------------------------------
// Pure legal-form words only — so "X Co." / "X Company" / "X" all normalize
// alike. Descriptive words (Trading, Group, Holding, General) are kept: they
// are part of a company's identity and dropping them causes false matches.
const LEGAL_SUFFIX_TOKENS = new Set([
  "co", "company", "corp", "corporation", "ltd", "limited", "llc", "inc", "incorporated", "plc", "شركة",
]);

// normalizeCoreName — lowercase, drop the bilingual second half, strip
// punctuation and legal-form suffix words, collapse spaces. "Acme Trading Co."
// and "acme trading" both normalize to "acme trading".
export function normalizeCoreName(name: string | null | undefined): string {
  let s = String(name || "").toLowerCase();
  s = s.split("|")[0].split(" - ")[0];               // drop bilingual/second half
  s = s.replace(/[^\p{L}\p{N}]+/gu, " ").trim();     // non-alphanumeric → space
  const tokens = s.split(/\s+/).filter(t => t && t.length >= 2 && !LEGAL_SUFFIX_TOKENS.has(t));
  return tokens.join(" ");
}

// significantTokens — the ≥4-char core-name tokens, for matching a domain root
// against an account name ("arabiandrilling" token in "Arabian Drilling").
export function significantTokens(name: string | null | undefined): string[] {
  return normalizeCoreName(name).split(/\s+/).filter(t => t.length >= 4);
}

const MULTI_PART_TLDS = ["com.sa", "edu.sa", "gov.sa", "org.sa", "net.sa", "med.sa", "sch.sa", "co.uk", "com.qa", "com.kw", "com.bh", "com.eg", "com.ae"];

// domainRootToken — the second-level label of a real domain ("arabiandrilling"
// from arabiandrilling.com, "kfshrc" from kfshrc.edu.sa). "" when not a real
// domain. Used to match a domain against account NAMES (accounts with no domain
// stored still get caught if their name contains the root).
export function domainRootToken(domain: string | null | undefined): string {
  let d = realDomainRoot(domain);
  if (!d) return "";
  for (const t of MULTI_PART_TLDS) {
    if (d.endsWith("." + t)) { d = d.slice(0, d.length - t.length - 1); return d.split(".").pop() || ""; }
  }
  const parts = d.split(".");
  if (parts.length >= 2) parts.pop();                 // strip single TLD
  return parts.pop() || "";
}

// ---------------------------------------------------------------------------
// Contact domain-consistency routing.
// The Mawsool export's "Company" label is an unreliable enrichment: rows
// grouped under one company name frequently carry corporate emails at
// entirely different companies. Before we file a contact under an Account we
// verify it belongs there, using the email domain as the authoritative
// employer signal. See docs/superpowers/specs/2026-07-02-contact-domain-routing-design.md
// ---------------------------------------------------------------------------
export type ContactRoute = "account" | "lead" | "reject";
export interface RoutedRow extends SPRow {
  route: ContactRoute;
  route_reason: string;
}

// mostCommon — pure helper: the most frequent non-null value in a list, or
// null. Deterministic tie-break by first-seen order.
function mostCommon(values: (string | null)[]): string | null {
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const v of values) {
    if (!v) continue;
    if (!counts.has(v)) order.push(v);
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const v of order) {
    const n = counts.get(v)!;
    if (n > bestN) { best = v; bestN = n; }
  }
  return best;
}

// routeContactsByDomainConsistency — pure. Assigns each row a route
// (account | lead | reject) per the rule in the design doc. Rows are grouped
// by the same company key the planner uses; ordering is preserved.
export function routeContactsByDomainConsistency(rows: SPRow[]): RoutedRow[] {
  // Group rows by company key (mirror groupByCompany's key), keeping a stable
  // reference back to each original row.
  const groups = new Map<string, SPRow[]>();
  for (const r of rows) {
    const key = normalizeCompanyKey(r.company, r.domain);
    const g = groups.get(key) || [];
    if (!groups.has(key)) groups.set(key, g);
    g.push(r);
  }

  // Per-group anchor, verified, and CRM-matched flags.
  const anchorByKey = new Map<string, string | null>();
  const verifiedByKey = new Map<string, boolean>();
  const crmMatchedByKey = new Map<string, boolean>();
  for (const [key, g] of groups) {
    const domainAnchor = mostCommon(g.map(r => realDomainRoot(r.domain)));
    const emailAnchor = mostCommon(g.map(r => realDomainRoot(r.email)));
    const anchor = domainAnchor || emailAnchor;
    const verified = !!anchor && g.some(r => realDomainRoot(r.email) === anchor);
    // A company already matched to a CRM Account (churned re-engage, or an
    // explicit matched_account_zoho_id / cluster) is trusted as-is — the label
    // was validated against the CRM, so we keep ALL its contacts rather than
    // re-verify by email domain.
    const crmMatched = g.some(
      r =>
        r.lifecycle_state === "termination_old" ||
        !!String(r.matched_account_zoho_id || "").trim() ||
        r.cluster_id != null,
    );
    anchorByKey.set(key, anchor);
    verifiedByKey.set(key, verified);
    crmMatchedByKey.set(key, crmMatched);
  }

  return rows.map(r => {
    const key = normalizeCompanyKey(r.company, r.domain);
    const anchor = anchorByKey.get(key) ?? null;
    const verified = verifiedByKey.get(key) ?? false;
    const crmMatched = crmMatchedByKey.get(key) ?? false;
    const emailRoot = realDomainRoot(r.email);      // non-null only for corporate email
    const hasEmail = !!String(r.email || "").trim();

    // A contact has no company IDENTITY when it carries neither a company name
    // nor a real company domain (identity would only be in the email, if any).
    const hasCompanyIdentity = !!(String(r.company || "").trim() || realDomainRoot(r.domain));

    let route: ContactRoute;
    let reason: string;
    if (crmMatched) {
      route = "account"; reason = "crm_matched_company";
    } else if (!hasCompanyIdentity) {
      // No company name AND no company domain — nothing to file an Account under,
      // and no label for an email to contradict. It becomes a Lead. The lead push
      // then live-checks the email domain and REJECTS it if that company is an
      // existing live client (never silently dropped, never a duplicate client).
      route = "lead"; reason = "no_company_identity";
    } else if (verified) {
      if (emailRoot && emailRoot === anchor) { route = "account"; reason = "email_matches_company"; }
      else if (emailRoot) { route = "reject"; reason = "email_contradicts_company"; }
      else if (!hasEmail) { route = "account"; reason = "phone_only_verified_company"; }
      else { route = "lead"; reason = "free_mail_verified_company"; }
    } else {
      if (emailRoot) { route = "reject"; reason = "corporate_email_unverifiable_company"; }
      else { route = "lead"; reason = "unverifiable_company"; }
    }
    return { ...r, route, route_reason: reason };
  });
}

// ---------------------------------------------------------------------------
// splitContactName — pure helper: splits a full display name into
// First_Name / Last_Name for Zoho Contact/Lead payloads. Single-token names
// (e.g. "Basserah") go entirely into Last_Name (Zoho requires Last_Name;
// First_Name is optional). Multi-token names put everything but the final
// token into First_Name, and the final token into Last_Name.
// ---------------------------------------------------------------------------
export function splitContactName(full: string | null | undefined): { first: string; last: string } {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: "", last: parts[0] };
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
}

function hasContact(r: SPRow): boolean {
  return !!(String(r.email || "").trim() || String(r.phone || "").trim() || String(r.contact_name || "").trim());
}

function groupByCompany(rows: SPRow[]): SPCompany[] {
  const map = new Map<string, SPCompany>();
  for (const r of rows) {
    const key = normalizeCompanyKey(r.company, r.domain);
    if (!key) continue;
    let g = map.get(key);
    if (!g) {
      g = { companyKey: key, companyName: r.company || r.domain || key, domain: r.domain || "", clusterId: r.cluster_id ?? null, contacts: [] };
      map.set(key, g);
    }
    if (r.cluster_id != null && g.clusterId == null) g.clusterId = r.cluster_id;
    g.contacts.push(r);
  }
  // Stable order by the smallest row_index in each group.
  return Array.from(map.values()).sort(
    (a, b) => Math.min(...a.contacts.map(c => c.row_index)) - Math.min(...b.contacts.map(c => c.row_index))
  );
}

export function buildStructuredPushPlan(
  action: 1 | 2 | 3 | 4,
  rows: SPRow[],
  opts: { count?: number; offset?: number; dealPercent?: number; dealBackfill?: boolean },
): StructuredPushPlan {
  const skipped: Array<{ row_index: number; reason: string }> = [];

  // ONLY verdict === "pass" rows are ever pushable. The caller may hand us the
  // full result set (block / review / duplicate / no-contact included); those
  // must never reach Zoho — e.g. the 563 "duplicate" rows already exist in the
  // CRM and would otherwise be pulled into A1 as existing-account links. A1 and
  // A4 don't re-check the verdict downstream, so we gate it here, up front.
  //
  // dealBackfill (action 1 ONLY) is the deliberate exception: create the MISSING
  // deals for companies we ALREADY pushed. Their accounts + contacts exist (so
  // the rows now read "duplicate"); we only need the deal. In that mode any row
  // that RESOLVED to an existing account (Layer-1 enrichment set
  // matched_account_zoho_id) is eligible — the A1 run reuses the account +
  // contacts and creates only the deal, skipping a company that already has an
  // open deal. It never creates accounts/contacts (they're found and reused).
  const pushableRows = opts.dealBackfill && action === 1
    ? rows.filter(r => !!String(r.matched_account_zoho_id || "").trim())
    : rows.filter(r => String(r.verdict || "").toLowerCase() === "pass");

  // Domain-consistency routing FIRST. Only "account"-routed rows may be filed
  // under an Account (A1/A2/A3). "lead"-routed rows become individual Leads
  // (A4). "reject"-routed rows (corporate email contradicting the company, or
  // a corporate email at an unverifiable company) are dropped and reported.
  const routed = routeContactsByDomainConsistency(pushableRows);
  const accountRows: SPRow[] = routed.filter(r => r.route === "account");
  const leadRows: SPRow[] = routed.filter(r => r.route === "lead");
  routed
    .filter(r => r.route === "reject")
    .forEach(r => skipped.push({ row_index: r.row_index, reason: r.route_reason }));

  // The matched/unmatched split is at the ROW level, not the group level: a
  // contact that matches an existing account (Layer 1) links to THAT account
  // even if a colleague on the same (wrong) label is genuinely new. This is why
  // two people under one bad label — one @riyadbank.com (existing), one
  // @newstartup.com (new) — correctly split: the first links to Riyad Bank
  // (A1), the second opens a new "New Startup" account (A3).
  const isRowExistingMatch = (r: SPRow) =>
    !!String(r.matched_account_zoho_id || "").trim() ||
    r.lifecycle_state === "termination_old" ||
    r.cluster_id != null;

  const isNewPass = (g: SPCompany) =>
    g.contacts.every(r => r.cluster_id == null) && g.contacts.every(r => r.verdict === "pass");
  const contactRows = (g: SPCompany) => g.contacts.filter(hasContact);

  // A1 rows link to EXISTING accounts; A2/A3 rows open NEW accounts.
  const matchedRows = accountRows.filter(isRowExistingMatch);
  const newGroups = groupByCompany(accountRows.filter(r => !isRowExistingMatch(r)));

  // Head-of-sales leads↔deals split: of the deal-ELIGIBLE new companies, only
  // `dealPercent`% are pushed as Deals (A2/A3); the rest are PARKED as Leads
  // (A4) for the sales team to work later. 100 = every new company eligible for
  // a deal (default / back-compat). Unverifiable / free-mail contacts are
  // ALWAYS leads regardless — they can never be a deal. The split is by COMPANY
  // (one company = one deal), ranked richest-first (most contacts = best
  // pipeline) with a deterministic row tiebreak so the same data splits the same
  // way every time.
  const dealPercent = Math.min(100, Math.max(0, Math.floor(opts.dealPercent ?? 100)));
  const newGroupsRanked = [...newGroups].sort((a, b) => {
    const byCount = contactRows(b).length - contactRows(a).length;
    if (byCount !== 0) return byCount;
    return Math.min(...a.contacts.map(c => c.row_index)) - Math.min(...b.contacts.map(c => c.row_index));
  });
  const dealGroupCount = Math.ceil((dealPercent / 100) * newGroupsRanked.length);
  const dealNewGroups = newGroupsRanked.slice(0, dealGroupCount);
  const parkedAsLeadRows: SPRow[] = newGroupsRanked.slice(dealGroupCount).flatMap(g => contactRows(g));
  // Parked new-company contacts join the A4 lead pool (after the naturally
  // lead-routed rows, so slicing order stays stable).
  const effectiveLeadRows: SPRow[] = leadRows.concat(parkedAsLeadRows);

  // Every action pushes ALL its eligible items in one request, which fires one
  // sequential Zoho Contact_Roles PUT per contact — a big batch (~200 contacts)
  // would exceed the gateway timeout. count/offset let the operator push in
  // slices (e.g. 20 at a time). count<=0 = push all (back-compat).
  const sliceCount = Math.max(0, Math.floor(opts.count ?? 0));
  const sliceOffset = Math.max(0, Math.floor(opts.offset ?? 0));
  const applySlice = <T,>(arr: T[]): T[] =>
    sliceCount > 0 ? arr.slice(sliceOffset, sliceOffset + sliceCount) : arr;

  if (action === 1) {
    // Group A1 contacts by their RESOLVED ACCOUNT (not the label), so contacts
    // linking to the same account merge and contacts at different real accounts
    // stay separate even under one shared bad label. Rows with no id yet
    // (churned in basic mode) fall back to the company key — the endpoint
    // resolves their account from domain/name.
    const byAcc = new Map<string, SPCompany>();
    for (const r of matchedRows) {
      const key = String(r.matched_account_zoho_id || "").trim() || ("name:" + normalizeCompanyKey(r.company, r.domain));
      let grp = byAcc.get(key);
      if (!grp) {
        // Prefer the RESOLVED account name (human-readable "links to <Account>")
        // over the row's often-wrong label.
        const displayName = String(r.matched_account_name || "").trim() || r.company || r.domain || key;
        grp = { companyKey: key, companyName: displayName, domain: r.domain || "", clusterId: r.cluster_id ?? null, contacts: [] };
        byAcc.set(key, grp);
      }
      if (!String(grp.companyName || "").trim() && String(r.matched_account_name || "").trim()) grp.companyName = String(r.matched_account_name).trim();
      if (r.cluster_id != null && grp.clusterId == null) grp.clusterId = r.cluster_id;
      grp.contacts.push(r);
    }
    const eligible = Array.from(byAcc.values()).sort(
      (a, b) => Math.min(...a.contacts.map(c => c.row_index)) - Math.min(...b.contacts.map(c => c.row_index)),
    );
    const companies = applySlice(eligible);
    return {
      action,
      companies,
      leads: [],
      eligible_count: companies.length,
      contact_count: companies.reduce((n, g) => n + g.contacts.length, 0),
      skipped,
    };
  }

  if (action === 2) {
    const eligible = dealNewGroups
      .filter(g => isNewPass(g) && contactRows(g).length >= 2)
      .map(g => ({ ...g, contacts: contactRows(g) }));
    const companies = applySlice(eligible);
    return {
      action,
      companies,
      leads: [],
      eligible_count: companies.length,
      contact_count: companies.reduce((n, g) => n + g.contacts.length, 0),
      skipped,
    };
  }

  if (action === 3) {
    const eligible = dealNewGroups
      .filter(g => isNewPass(g) && contactRows(g).length === 1)
      .map(g => ({ ...g, contacts: contactRows(g) }));
    const companies = applySlice(eligible);
    return {
      action,
      companies,
      leads: [],
      eligible_count: companies.length,
      contact_count: companies.length,
      skipped,
    };
  }

  // action === 4 — every lead-routed contact PLUS any new companies parked as
  // leads by the deal split, sliced by count/offset.
  const leads = applySlice(effectiveLeadRows);
  return {
    action,
    companies: [],
    leads,
    eligible_count: leads.length,
    contact_count: leads.length,
    skipped,
  };
}
