export const PREFLIGHT_DEAL_TARGET = {
  layoutId: process.env.PREFLIGHT_DEAL_LAYOUT_ID || "5146753000000019023",
  pipeline: process.env.PREFLIGHT_DEAL_PIPELINE || "Standard (Corporates)",
  stage: process.env.PREFLIGHT_DEAL_STAGE || "New Deal",
};
export const PREFLIGHT_LEAD_TARGET = {
  layoutId: process.env.PREFLIGHT_LEAD_LAYOUT_ID || "5146753000000091055",
  status: process.env.PREFLIGHT_LEAD_STATUS || "New Lead",
};

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

// websiteFromDomain — pure. Returns a clean https:// URL for a REAL company
// domain, or null for blank/placeholder/free-mail domains (which must not be
// written to the CRM). A real domain must contain a dot and a plausible TLD.
export function websiteFromDomain(domain: string | null | undefined): string | null {
  let d = String(domain || "").trim().toLowerCase();
  if (!d) return null;
  d = d.replace(/^https?:\/\//, "").replace(/\/.*$/, "");   // strip scheme/path
  d = d.split("@").pop() || d;                               // strip any local-part
  if (!d || FREE_MAIL_OR_PLACEHOLDER.has(d)) return null;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+\.?$/.test(d)) return null; // needs a dotted TLD
  return `https://${d.replace(/\.$/, "")}`;
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
  opts: { count?: number; offset?: number },
): StructuredPushPlan {
  const skipped: Array<{ row_index: number; reason: string }> = [];
  const groups = groupByCompany(rows);

  // Churned PAST cool-off = re-engage under the existing Account. The account is
  // resolved by the endpoint from cluster_id when present, else by domain/name
  // (basic-mode preflight matches churned clients via the CS directory and sets
  // NO cluster_id — so requiring cluster_id here made this action always empty).
  const isChurnedMatched = (g: SPCompany) =>
    g.contacts.some(r => r.lifecycle_state === "termination_old");
  const isNewPass = (g: SPCompany) =>
    g.contacts.every(r => r.cluster_id == null) && g.contacts.every(r => r.verdict === "pass");
  const contactRows = (g: SPCompany) => g.contacts.filter(hasContact);

  // A1/A2 push ALL their eligible companies in one request, which fires one
  // sequential Zoho Contact_Roles PUT per contact — a 99-company A2 (~200
  // contacts) would exceed the gateway timeout. count/offset let the operator
  // push in slices (e.g. 20 at a time). count<=0 = push all (back-compat).
  const sliceCount = Math.max(0, Math.floor(opts.count ?? 0));
  const sliceOffset = Math.max(0, Math.floor(opts.offset ?? 0));
  const applySlice = <T,>(arr: T[]): T[] =>
    sliceCount > 0 ? arr.slice(sliceOffset, sliceOffset + sliceCount) : arr;

  if (action === 1) {
    const eligible = groups.filter(isChurnedMatched);
    const companies = applySlice(eligible);
    groups
      .filter(g => !isChurnedMatched(g))
      .forEach(g => g.contacts.forEach(r => skipped.push({ row_index: r.row_index, reason: "not_churned_past_cooloff" })));
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
    const eligible = groups
      .filter(g => !isChurnedMatched(g) && isNewPass(g) && contactRows(g).length >= 2)
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

  // A3/A4 share the single-contact-new pool, ordered by row_index.
  const singleNew = groups
    .filter(g => !isChurnedMatched(g) && isNewPass(g) && contactRows(g).length === 1)
    .map(g => ({ ...g, contacts: contactRows(g) }));

  const n = Math.max(0, Math.floor(opts.count ?? 0));

  if (action === 3) {
    const companies = singleNew.slice(0, n);
    return {
      action,
      companies,
      leads: [],
      eligible_count: companies.length,
      contact_count: companies.length,
      skipped,
    };
  }

  // action === 4 — the NEXT M after action 3's slice.
  // opts.offset = the N already consumed by action 3.
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const leads = singleNew.slice(offset, offset + n).flatMap(g => g.contacts);
  return {
    action,
    companies: [],
    leads,
    eligible_count: leads.length,
    contact_count: leads.length,
    skipped,
  };
}
