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

  if (action === 1) {
    const companies = groups.filter(isChurnedMatched);
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
    const companies = groups
      .filter(g => !isChurnedMatched(g) && isNewPass(g) && contactRows(g).length >= 2)
      .map(g => ({ ...g, contacts: contactRows(g) }));
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
