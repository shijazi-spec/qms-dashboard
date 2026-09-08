/**
 * SPLIT-ACCOUNT DEAL CONFLICTS — the reverse of the Active Deal Conflicts tab.
 *
 * The Active Deal Conflicts tab (`getMultiActiveDealAccounts`) answers "which
 * ACCOUNT carries more than one open deal". It deliberately cannot see the
 * mirror-image failure: ONE company split across TWO OR MORE Account records
 * with a single open deal on each. Two sellers are still working the same
 * client and the pipeline is still double-counted — but every account looks
 * clean on its own, so nothing is flagged.
 *
 * Found on live data 2026-09-09 while confirming a batch of accounts against
 * the tab: `Yanbu Aramco Sinopec ياسرف` (On Hold, فايز الأسمري) and
 * `Yanbu Aramco` (New Deal, Yahya Alshehri) are the same company on two
 * Account records, and neither appeared. Same shape for Lendo, which has an
 * open Proposal on one record while the other record is already Agreement
 * Signed.
 *
 * WHY THIS IS A SEPARATE CHECK, NOT A WIDENING OF THE MAIN QUERY
 * The main tab groups on domain → account id → name, and joining across
 * Account records needs a fuzzy company match. Fuzzy evidence must never
 * silently inflate a tab Sales acts on, so this is reported apart and every
 * group carries the SIGNAL that produced it. Nothing here is auto-actioned;
 * the fix is always "merge the Account records", which is Account Duplicates'
 * job.
 *
 * KNOWN BLIND SPOT (do not claim this is exhaustive): a short brand name plus
 * an Arabic alias will not join. `Stc` / `stcbank` / `الاتصالات السعودية` /
 * `STC العناية بالموظفين` are one company holding four open WalaPlus deals
 * across four Account records, and this check misses them — "stc" is 3
 * characters, below MIN_JOIN_LEN, and no token is shared with the Arabic
 * names. Catching that class needs an alias map, not a better matcher.
 */

import { pool, buildSegmentPredicate, openStagePredicate, normalizeCompanyName } from "./duplicateRadarDatabase";
import type { DuplicateFilters } from "./duplicateRadarDatabase";

/**
 * Shortest normalized token/name allowed to join two accounts. Same value and
 * same reason as `MIN_FUZZY_LEN` in companyNameBatch: below this, stubs like
 * "co" or "stc" swallow unrelated companies.
 */
const MIN_JOIN_LEN = 4;

export type SplitAccountSignal = "domain" | "exact_name" | "name_containment";

export interface SplitAccountDeal {
  id: string;
  name: string;
  stage: string;
  owner: string;
  amount: number;
  layout: string;
  created: string | null;
}

export interface SplitAccountSide {
  account_id: string;
  account_name: string;
  domain: string | null;
  deals: SplitAccountDeal[];
}

export interface SplitAccountConflict {
  company: string;
  /** What joined these Account records. `domain` is proof; the name signals
   *  are evidence to VERIFY, never a confirmed duplicate. */
  signal: SplitAccountSignal;
  accounts: SplitAccountSide[];
  account_count: number;
  open_deals: number;
  distinct_owners: number;
  owners: string[];
  total_open_value: number;
  /** True when at least one of these accounts ALSO carries 2+ open deals on
   *  its own — i.e. it is already on the Active Deal Conflicts tab, and this
   *  group is wider than what that tab shows. */
  overlaps_main_tab: boolean;
}

/** True when `needle` sits inside `haystack` on word boundaries. Normalized
 *  names are space-separated, so this stops "aster" matching "master builders".
 *  Same rule as companyNameBatch's `containsToken`. */
function containsToken(haystack: string, needle: string): boolean {
  if (needle === haystack) return true;
  return (
    haystack.startsWith(needle + " ") ||
    haystack.endsWith(" " + needle) ||
    haystack.includes(" " + needle + " ")
  );
}

/** Bare host for an account's domain/website, or null. */
export function normalizeAccountDomain(raw: string | null | undefined): string | null {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return null;
  const host = s
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "")
    .trim();
  return host || null;
}

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let p = this.parent.get(x);
    if (p === undefined) {
      this.parent.set(x, x);
      return x;
    }
    if (p !== x) {
      p = this.find(p);
      this.parent.set(x, p);
    }
    return p;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/**
 * PURE. Group accounts-with-open-deals into companies that are split across
 * two or more Account records.
 *
 * Signals, strongest first — the strongest one that touched a group is the one
 * reported:
 *   1. domain      — identical bare host on both Account records. Proof.
 *   2. exact_name  — identical normalized company name. Proof in practice.
 *   3. name_containment — one normalized name contains the other on token
 *      boundaries ("yanbu aramco" inside "yanbu aramco sinopec ياسرف").
 *      Evidence to verify.
 *
 * Containment is compared only within a shared FIRST TOKEN bucket. That keeps
 * this linear-ish instead of O(n²) over every account in the layout, and the
 * cases it gives up ("Aramco Yanbu" vs "Yanbu Aramco") are word-order variants
 * that Account Duplicates already handles on its own.
 */
export function groupSplitAccountConflicts(
  sides: SplitAccountSide[],
): SplitAccountConflict[] {
  const byId = new Map<string, SplitAccountSide>();
  for (const s of sides) {
    if (!s.account_id || !s.deals?.length) continue;
    byId.set(s.account_id, s);
  }
  const ids = Array.from(byId.keys());
  if (ids.length < 2) return [];

  const uf = new UnionFind();
  const signalFor = new Map<string, SplitAccountSignal>();
  const noteSignal = (a: string, b: string, sig: SplitAccountSignal) => {
    uf.union(a, b);
    const root = uf.find(a);
    const held = signalFor.get(root);
    const rank = { domain: 3, exact_name: 2, name_containment: 1 } as const;
    if (!held || rank[sig] > rank[held]) signalFor.set(root, sig);
  };

  // 1. domain
  const byDomain = new Map<string, string[]>();
  for (const id of ids) {
    const d = normalizeAccountDomain(byId.get(id)!.domain);
    if (!d) continue;
    (byDomain.get(d) || byDomain.set(d, []).get(d)!).push(id);
  }
  for (const group of byDomain.values()) {
    for (let i = 1; i < group.length; i++) noteSignal(group[0], group[i], "domain");
  }

  // 2. exact normalized name, and bucket for 3.
  const norms = new Map<string, string>();
  const byNorm = new Map<string, string[]>();
  const byFirstToken = new Map<string, string[]>();
  for (const id of ids) {
    const n = normalizeCompanyName(byId.get(id)!.account_name || "").trim();
    if (!n || n.length < MIN_JOIN_LEN) continue;
    norms.set(id, n);
    (byNorm.get(n) || byNorm.set(n, []).get(n)!).push(id);
    const first = n.split(" ")[0];
    if (first && first.length >= MIN_JOIN_LEN) {
      (byFirstToken.get(first) || byFirstToken.set(first, []).get(first)!).push(id);
    }
  }
  for (const group of byNorm.values()) {
    for (let i = 1; i < group.length; i++) noteSignal(group[0], group[i], "exact_name");
  }

  // 3. token-aligned containment, within a shared first token
  for (const bucket of byFirstToken.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = norms.get(bucket[i])!;
        const b = norms.get(bucket[j])!;
        if (containsToken(a, b) || containsToken(b, a)) {
          noteSignal(bucket[i], bucket[j], "name_containment");
        }
      }
    }
  }

  // Collect
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const root = uf.find(id);
    (groups.get(root) || groups.set(root, []).get(root)!).push(id);
  }

  const out: SplitAccountConflict[] = [];
  for (const [root, memberIds] of groups.entries()) {
    if (memberIds.length < 2) continue; // a lone account is the main tab's job
    const accounts = memberIds
      .map((id) => byId.get(id)!)
      .sort((a, b) => b.deals.length - a.deals.length);
    const deals = accounts.flatMap((a) => a.deals);
    if (deals.length < 2) continue;
    const owners = Array.from(new Set(deals.map((d) => d.owner).filter(Boolean)));
    // Longest name reads best as the group label, same choice the main tab makes.
    const company = accounts
      .map((a) => a.account_name || "")
      .sort((a, b) => b.length - a.length)[0];
    out.push({
      company,
      signal: signalFor.get(root) || "name_containment",
      accounts,
      account_count: accounts.length,
      open_deals: deals.length,
      distinct_owners: owners.length,
      owners,
      total_open_value: deals.reduce((n, d) => n + (Number(d.amount) || 0), 0),
      overlaps_main_tab: accounts.some((a) => a.deals.length > 1),
    });
  }

  // Domain-proven first, then the biggest collisions.
  const sigRank = { domain: 3, exact_name: 2, name_containment: 1 } as const;
  return out.sort(
    (a, b) =>
      sigRank[b.signal] - sigRank[a.signal] ||
      b.distinct_owners - a.distinct_owners ||
      b.open_deals - a.open_deals ||
      b.total_open_value - a.total_open_value,
  );
}

/**
 * Run the reverse check for one layout. Same layout scoping as the main tab —
 * an explicit segment is honoured, and the default is WalaPlus rather than
 * "all", because comparing a WalaPlus deal against a WalaOne deal would
 * manufacture violations out of legitimate second-product sales.
 */
export async function getSplitAccountDealConflicts(
  segment: DuplicateFilters["segment"],
): Promise<{
  segment: string;
  companies: SplitAccountConflict[];
  accounts_scanned: number;
}> {
  const seg = !segment || segment === "corporate" ? "walaplus" : segment;
  const p = buildSegmentPredicate(seg, 1);
  const segCond = p.condition ? " AND " + p.condition : "";

  // Every open deal on the layout, keyed to its Account record. Accounts with
  // 2+ open deals are kept: a split company can also be doubled on one of its
  // records, and dropping them would under-report the group.
  const res = await pool.query(
    `SELECT r.zoho_record_id AS id,
            COALESCE(NULLIF(BTRIM(r.record_name),''), r.zoho_record_id) AS name,
            COALESCE(NULLIF(BTRIM(r.stage),''), r.raw_data->>'Stage', '') AS stage,
            COALESCE(NULLIF(BTRIM(r.owner_name),''), NULLIF(BTRIM(r.owner_email),''), 'Unassigned') AS owner,
            COALESCE(r.deal_value, 0)::float AS amount,
            COALESCE(NULLIF(BTRIM(r.layout_name), ''), '') AS layout,
            r.created_date AS created,
            NULLIF(BTRIM(r.raw_data->'Account_Name'->>'id'), '') AS account_id,
            COALESCE(
              NULLIF(BTRIM(r.raw_data->'Account_Name'->>'name'), ''),
              NULLIF(BTRIM(r.company_name), '')
            ) AS account_name
       FROM duplicate_records r
      WHERE r.record_type = 'deal'
        AND (${openStagePredicate("r")})${segCond}
        AND NULLIF(BTRIM(r.raw_data->'Account_Name'->>'id'), '') IS NOT NULL`,
    [...p.params],
  );

  const sides = new Map<string, SplitAccountSide>();
  for (const row of res.rows as any[]) {
    const acct = String(row.account_id);
    let side = sides.get(acct);
    if (!side) {
      side = {
        account_id: acct,
        account_name: String(row.account_name || "").trim(),
        domain: null,
        deals: [],
      };
      sides.set(acct, side);
    }
    side.deals.push({
      id: String(row.id),
      name: String(row.name || ""),
      stage: String(row.stage || ""),
      owner: String(row.owner || ""),
      amount: Number(row.amount) || 0,
      layout: String(row.layout || ""),
      created: row.created ? String(row.created) : null,
    });
  }

  // Account domains in one bounded query, keyed on the accounts we actually
  // hold — the same shape as the main tab's second pass, and the reason a
  // LEFT JOIN LATERAL is not used here (it took that query from ~1s to 13s).
  const acctIds = Array.from(sides.keys());
  if (acctIds.length) {
    const dres = await pool.query(
      `SELECT zoho_record_id AS id,
              NULLIF(BTRIM(record_name), '') AS name,
              COALESCE(NULLIF(BTRIM(domain), ''), NULLIF(BTRIM(website), '')) AS domain
         FROM duplicate_records
        WHERE record_type = 'account'
          AND zoho_record_id = ANY($1::text[])`,
      [acctIds],
    );
    for (const row of dres.rows as any[]) {
      const side = sides.get(String(row.id));
      if (!side) continue;
      side.domain = normalizeAccountDomain(row.domain);
      // The Account's own name beats the name copied onto the deal, which
      // varies per deal for one Account ("Stc", "stcbank", "STC العناية").
      if (row.name) side.account_name = String(row.name).trim();
    }
  }

  return {
    segment: seg,
    companies: groupSplitAccountConflicts(Array.from(sides.values())),
    accounts_scanned: sides.size,
  };
}
