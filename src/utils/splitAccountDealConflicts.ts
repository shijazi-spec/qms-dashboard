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

import {
  pool,
  buildSegmentPredicate,
  openStagePredicate,
  normalizeCompanyName,
  isPlaceholderName,
  separationKey,
  getSeparationPairKeySet,
} from "./duplicateRadarDatabase";
import type { DuplicateFilters } from "./duplicateRadarDatabase";

/**
 * Shortest normalized token/name allowed to join two accounts. Same value and
 * same reason as `MIN_FUZZY_LEN` in companyNameBatch: below this, stubs like
 * "co" or "stc" swallow unrelated companies.
 */
const MIN_JOIN_LEN = 4;

/**
 * Leading words that name a CATEGORY of client rather than a client, so two
 * accounts sharing one are not evidence of anything.
 *
 * Found on the first live run (2026-09-09): the largest group this check
 * returned was four Account records — "Confidential Government",
 * "Confidential- الخطوط السعودية", "Confidential", "Confidential ( Consulting
 * Firm)" — carrying five open deals under five different owners. They are four
 * DIFFERENT clients whose names were withheld, and merging them would have sent
 * five sellers a collision that does not exist.
 *
 * Deliberately short and evidence-driven: every entry is a word actually seen
 * standing in for a withheld or unentered name. Do not pad it with plausible
 * guesses — a word listed here silently disables name matching for every
 * account that starts with it. Note `normalizeCompanyName` already strips
 * company/group/holding/co and their Arabic equivalents, so those never reach
 * this check as a first token.
 */
const NON_IDENTIFYING_FIRST_TOKENS = new Set<string>([
  "confidential",
  "anonymous",
  "undisclosed",
  "placeholder",
  "unnamed",
  "سري",
  "سرية",
]);

/**
 * True when a name is too generic to join ANOTHER account on. Placeholder names
 * ("N/A", "لا يوجد") and category stand-ins ("Confidential …") both qualify.
 *
 * This gates the NAME signals only. A shared domain still joins these accounts,
 * because a domain is proof regardless of how badly the record is named.
 */
export function isNonIdentifyingCompanyName(name: string | null | undefined): boolean {
  if (isPlaceholderName(name)) return true;
  const norm = normalizeCompanyName(String(name || "")).trim();
  if (!norm) return true;
  return NON_IDENTIFYING_FIRST_TOKENS.has(norm.split(" ")[0]);
}

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
  /**
   * Other names this account is known by — deal names and deal company names.
   * The account record is often the worst-named thing in the cluster, so
   * matching on its name alone loses the split whenever that is the sloppy
   * field. See accountAliases. Optional: the narrow check does not use them.
   */
  aliases?: string[];
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
  /**
   * Account-id pairs an operator dismissed as "not the same company", from
   * duplicate_separation_ledger.
   *
   * Sarah 2026-09-10: the join is fuzzy by design, and the case it gets wrong
   * is SISTER COMPANIES — two real, separate businesses that share a domain or
   * a name token. There is no conflict to resolve, so without a way to say so
   * the group returns every scan forever.
   *
   * Applied as a refusal to UNION, not as a filter over finished groups: a
   * dismissed pair should remove exactly that edge. If a third account joins
   * the other two by a signal nobody dismissed, that group is still real and
   * must still be reported.
   */
  separatedPairs?: Set<string>,
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
    // Dismissed pairs never join — including on `domain`, which is otherwise
    // treated as proof. Two sister companies really do share one domain, and a
    // person who has looked at the records outranks the signal.
    if (separatedPairs && separatedPairs.has(separationKey(a, b))) return;
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
  // Pairwise, not chained from group[0].
  //
  // With every edge accepted the two are identical — union-find produces the
  // same component either way — so this is not a behaviour change on its own.
  // It matters once an edge can be REFUSED: chaining asks only "group[0] vs
  // each", so dismissing (a,b) as sister companies would also detach b from c,
  // a pair nobody dismissed and which shares the same domain. That would hide
  // a real conflict, and hiding one is the failure this module exists to stop.
  // Buckets hold accounts sharing one identical domain, so k is small.
  for (const group of byDomain.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        noteSignal(group[i], group[j], "domain");
      }
    }
  }

  // 2. exact normalized name, and bucket for 3.
  //
  // Placeholder and category names are excluded from BOTH name signals here —
  // they never enter `norms`, so they cannot join or be joined by name. The
  // domain pass above already ran, so a badly-named account with a real domain
  // is still grouped.
  const norms = new Map<string, string>();
  const byNorm = new Map<string, string[]>();
  const byFirstToken = new Map<string, string[]>();
  for (const id of ids) {
    const rawName = byId.get(id)!.account_name || "";
    if (isNonIdentifyingCompanyName(rawName)) continue;
    const n = normalizeCompanyName(rawName).trim();
    if (!n || n.length < MIN_JOIN_LEN) continue;
    norms.set(id, n);
    (byNorm.get(n) || byNorm.set(n, []).get(n)!).push(id);
    const first = n.split(" ")[0];
    if (first && first.length >= MIN_JOIN_LEN) {
      (byFirstToken.get(first) || byFirstToken.set(first, []).get(first)!).push(id);
    }
  }
  // Pairwise for the same reason as the domain pass above.
  for (const group of byNorm.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        noteSignal(group[i], group[j], "exact_name");
      }
    }
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

/* ── The whole-book sweep ─────────────────────────────────────────────────── */

/**
 * WHY THE WHOLE-BOOK SWEEP GROUPS DIFFERENTLY FROM THE NARROW CHECK ABOVE.
 *
 * Run over the 1,361 accounts that already hold open deals, token containment
 * behaves: it found Yanbu Aramco and الفران and fifteen others, all real.
 * Run over all 8,985 accounts in the sales book, it collapses (measured
 * 2026-09-11):
 *
 *   42 different government authorities became ONE company, because they all
 *      begin الهيئة — "the Authority".
 *   21 companies became "Riyadh Second Health Cluster": Riyadh Air, Riyadh
 *      Cables, Riyadh Marriott, Riyadh Municipality — they share a CITY.
 *   18 became one "National" company, 14 one "تطوير" (development) company.
 *
 * Two causes. Generic leading words are categories, not names — the same
 * mistake as "Confidential", which was fixed for withheld names and never
 * generalised. And union-find is TRANSITIVE: one account named "الهيئة العامة"
 * is contained in forty others, so a single generic hub chains them all
 * together even though no two of them match each other.
 *
 * So at book scale only PROOF may group: an identical domain or an identical
 * normalized name. Containment still carries signal — it is how الفران was
 * found — but it is emitted as individual PAIRS that a person reads, never as
 * a transitive group. A wrong pair costs one dismissal; a wrong group of 42
 * costs the credibility of the whole list.
 */

/**
 * EVERY NAME AN ACCOUNT IS KNOWN BY — the account's own name, and the name and
 * company_name of every deal booked against it (Sarah 2026-09-11: "you can
 * check the deal name, company name, or domain, so you always have a way to
 * catch these").
 *
 * The account record is often the WORST-named thing in the cluster. الفران's
 * two accounts were "الفران" and "شركة الفران العربية", but the deals under
 * them carried the same names again — and elsewhere the deal is the only place
 * the real company name was ever typed. Matching on one field means losing the
 * split whenever that field is the sloppy one.
 *
 * Every alias goes through the same fan-out guard as the account name: a name
 * shared by more accounts than the cap is a category ("New Deal", "الهيئة"),
 * whatever field it came from.
 */
export function accountAliases(side: SplitAccountSide): string[] {
  const raw = [side.account_name, ...(side.aliases || [])];
  const out = new Set<string>();
  for (const r of raw) {
    if (isNonIdentifyingCompanyName(r)) continue;
    const n = normalizeCompanyName(String(r || "")).trim();
    if (n && n.length >= MIN_JOIN_LEN) out.add(n);
  }
  return Array.from(out);
}

/** A containment match, reported one edge at a time. Never chained. */
export interface SplitAccountPair {
  a: { account_id: string; account_name: string; domain: string | null };
  b: { account_id: string; account_name: string; domain: string | null };
  /** The shorter normalized name that sits inside the longer one. */
  shared: string;
}

/**
 * How many other accounts one name may sit inside before it is treated as a
 * category rather than a name.
 *
 * Token count cannot make this call, and trying cost a real case: "الفران" is
 * ONE token and a genuine company name, while "الهيئة" is one token and means
 * "the Authority". A ≥2-token rule threw away الفران — the very split this
 * sweep was built to find.
 *
 * FAN-OUT separates them cleanly. "الهيئة" is contained in forty accounts;
 * "الفران" in one. A name that matches half the book is describing a category,
 * whatever its length. Three is deliberately generous — a company with four
 * genuine name variants is rare, and the cost of being wrong is one pair to
 * dismiss rather than a group of forty.
 */
const MAX_CONTAINMENT_FANOUT = 3;

/**
 * PURE. Which normalized names are DISTINCTIVE across this book — i.e. not
 * shared by more accounts than the fan-out cap.
 *
 * Computed once over every alias of every account, because a name is only
 * knowable as a category by looking at the whole field. "New Deal" as a deal
 * name and "الهيئة" as an account name fail here for the same reason.
 */
export function distinctiveNames(sides: SplitAccountSide[]): Set<string> {
  const count = new Map<string, Set<string>>();
  for (const s of sides) {
    for (const n of accountAliases(s)) {
      (count.get(n) || count.set(n, new Set()).get(n)!).add(s.account_id);
    }
  }
  const out = new Set<string>();
  for (const [name, accounts] of count) {
    if (accounts.size <= MAX_CONTAINMENT_FANOUT) out.add(name);
  }
  return out;
}

/**
 * PURE. Group ONLY on proof — an identical domain, or a DISTINCTIVE name that
 * two accounts share, from any field. No containment, therefore no chaining.
 */
export function groupByProof(
  sides: SplitAccountSide[],
  separatedPairs?: Set<string>,
): SplitAccountConflict[] {
  const distinctive = distinctiveNames(sides);
  // Re-key each account on its aliases so a shared DEAL name joins two
  // accounts the account names alone would have missed. The deals stay as
  // they are; only the matching surface widens.
  const rekeyed: SplitAccountSide[] = sides.map((s) => {
    const names = accountAliases(s).filter((n) => distinctive.has(n));
    return { ...s, aliases: names };
  });
  const byId = new Map(rekeyed.map((s) => [s.account_id, s]));
  const uf = new UnionFind();
  const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const signalFor = new Map<string, SplitAccountSignal>();

  const join = (a: string, b: string, sig: SplitAccountSignal) => {
    if (separatedPairs?.has(key(a, b))) return;
    uf.union(a, b);
    const root = uf.find(a);
    const held = signalFor.get(root);
    if (!held || (sig === "domain" && held !== "domain")) signalFor.set(root, sig);
    else if (!held) signalFor.set(root, sig);
  };

  const byDomain = new Map<string, string[]>();
  const byName = new Map<string, string[]>();
  for (const s of rekeyed) {
    if (!s.deals?.length) continue;
    const d = normalizeAccountDomain(s.domain);
    if (d) (byDomain.get(d) || byDomain.set(d, []).get(d)!).push(s.account_id);
    for (const n of s.aliases || []) {
      (byName.get(n) || byName.set(n, []).get(n)!).push(s.account_id);
    }
  }
  for (const ids of byDomain.values())
    for (let i = 1; i < ids.length; i++) join(ids[0], ids[i], "domain");
  for (const ids of byName.values())
    for (let i = 1; i < ids.length; i++) join(ids[0], ids[i], "exact_name");

  const groups = new Map<string, string[]>();
  for (const s of rekeyed) {
    if (!s.deals?.length) continue;
    const root = uf.find(s.account_id);
    (groups.get(root) || groups.set(root, []).get(root)!).push(s.account_id);
  }

  const out: SplitAccountConflict[] = [];
  for (const [root, ids] of groups) {
    if (ids.length < 2) continue;
    const accounts = ids.map((i) => byId.get(i)!);
    const byDealId = new Map<string, SplitAccountDeal>();
    for (const a of accounts) for (const d of a.deals) byDealId.set(String(d.id), d);
    const deals = [...byDealId.values()];
    if (deals.length < 2) continue;
    const owners = Array.from(new Set(deals.map((d) => d.owner).filter(Boolean)));
    out.push({
      company: accounts.map((a) => a.account_name || "").sort((x, y) => y.length - x.length)[0],
      signal: signalFor.get(root) || "exact_name",
      accounts,
      account_count: accounts.length,
      open_deals: deals.length,
      distinct_owners: owners.length,
      owners,
      total_open_value: deals.reduce((n, d) => n + (Number(d.amount) || 0), 0),
      overlaps_main_tab: accounts.some((a) => a.deals.length > 1),
    });
  }
  return out.sort(
    (a, b) =>
      b.distinct_owners - a.distinct_owners ||
      b.open_deals - a.open_deals ||
      b.total_open_value - a.total_open_value,
  );
}

/**
 * PURE. Containment matches as individual pairs.
 *
 * Collected in two passes: every candidate edge first, then every edge dropped
 * whose contained name proved to be a hub. The count only means something once
 * the whole book has been walked, so the filter cannot run inline.
 */
export function containmentPairs(
  sides: SplitAccountSide[],
  separatedPairs?: Set<string>,
): SplitAccountPair[] {
  // Every name each account is known by — account name AND deal names — so a
  // split survives one badly-named account record.
  const distinctive = distinctiveNames(sides);
  const namesOf = new Map<string, string[]>();
  const byFirstToken = new Map<string, string[]>();
  const byId = new Map<string, SplitAccountSide>();
  for (const s of sides) {
    if (!s.account_id) continue;
    const names = accountAliases(s).filter((n) => distinctive.has(n));
    if (!names.length) continue;
    namesOf.set(s.account_id, names);
    byId.set(s.account_id, s);
    for (const n of names) {
      const first = n.split(" ")[0];
      if (first && first.length >= MIN_JOIN_LEN) {
        const b = byFirstToken.get(first) || byFirstToken.set(first, []).get(first)!;
        if (!b.includes(s.account_id)) b.push(s.account_id);
      }
    }
  }
  const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const seen = new Set<string>();
  const side = (id: string) => {
    const s = byId.get(id)!;
    return { account_id: s.account_id, account_name: s.account_name, domain: s.domain };
  };

  // PASS 1 — every candidate edge, and how often each contained name is used.
  const edges: SplitAccountPair[] = [];
  const fanOut = new Map<string, number>();
  for (const bucket of byFirstToken.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const ida = bucket[i];
        const idb = bucket[j];
        const k = key(ida, idb);
        if (seen.has(k)) continue;
        if (separatedPairs?.has(k)) continue;
        // Best containment across ANY pair of their names — the match may sit
        // between one account's DEAL name and the other's account name.
        let best: string | null = null;
        for (const a of namesOf.get(ida)!) {
          for (const b of namesOf.get(idb)!) {
            if (a === b) { best = null; break; } // identical is proof, already grouped
            const shorter = a.length <= b.length ? a : b;
            const longer = shorter === a ? b : a;
            if (!containsToken(longer, shorter)) continue;
            if (!best || shorter.length > best.length) best = shorter;
          }
          if (best === null && namesOf.get(ida)!.some((x) => namesOf.get(idb)!.includes(x))) break;
        }
        if (!best) continue;
        seen.add(k);
        edges.push({ a: side(ida), b: side(idb), shared: best });
        fanOut.set(best, (fanOut.get(best) || 0) + 1);
      }
    }
  }

  // PASS 2 — drop the hubs. A name inside more accounts than the cap is
  // describing a category, and every edge it produced is noise.
  return edges.filter((e) => (fanOut.get(e.shared) || 0) <= MAX_CONTAINMENT_FANOUT);
}

export type SplitCompanyClass = "active_conflict" | "merge_needed";

export interface SplitCompany {
  company: string;
  signal: SplitAccountSignal;
  /** active_conflict — two or more of these accounts carry an OPEN deal right
   *  now, so two sellers are working one client and no tab shows it.
   *  merge_needed — the split exists but has not produced a conflict yet. */
  classification: SplitCompanyClass;
  accounts: Array<{
    account_id: string;
    account_name: string;
    domain: string | null;
    open_deals: SplitAccountDeal[];
    total_deals: number;
  }>;
  account_count: number;
  open_deals: number;
  distinct_owners: number;
  owners: string[];
  total_open_value: number;
}

/**
 * EVERY company in the sales book that is split across two or more Account
 * records — whether or not it has already caused a deal conflict.
 *
 * Sarah 2026-09-11, after finding الفران: two open Proposals, two owners, two
 * Account records, and NOTHING flagged it. Active Deal Conflicts asks "which
 * ACCOUNT has more than one open deal" and each had exactly one. Account
 * Duplicates never clustered them either — neither record carries a domain and
 * the names differ ("الفران" vs "شركة الفران العربية"). The company was
 * invisible to both tabs at once.
 *
 * So this sweeps the whole book rather than only the accounts already in
 * conflict, and splits the result in two:
 *
 *   active_conflict — fix NOW. Two sellers on one client today.
 *   merge_needed    — fix BEFORE it bites. One account is dormant, but the
 *                     next deal logged against the wrong record recreates the
 *                     same invisible conflict.
 *
 * SCOPE: accounts that carry at least one deal on this layout. A company with
 * no deal at all is an Account Duplicates question, not a sales one, and
 * including them would bury the rows that matter under dormant records.
 */
export async function getSplitAccountCompanies(
  segment: DuplicateFilters["segment"],
): Promise<{
  segment: string;
  companies: SplitCompany[];
  accounts_scanned: number;
  active_conflicts: number;
  merge_needed: number;
  /**
   * Name-containment matches, one edge each, for a person to read. NOT grouped
   * and NOT chained. Each carries whether both sides currently hold open deals,
   * so a reviewer can start with the ones that are already a live collision.
   */
  possible_pairs: Array<
    SplitAccountPair & { a_open_deals: number; b_open_deals: number }
  >;
}> {
  const seg = !segment || segment === "corporate" ? "walaplus" : segment;
  const p1 = buildSegmentPredicate(seg, 1);
  const segCond1 = p1.condition ? " AND " + p1.condition : "";

  // Every account this layout's deals point at, with its name and domain, and
  // how many deals it holds in total — one row per account, bounded by the
  // sales book rather than the whole Accounts module.
  const res = await pool.query(
    // Deal names and company names come back as ALIASES. The account record is
    // often the worst-named thing in the cluster — الفران's accounts were
    // "الفران" and "شركة الفران العربية" — and elsewhere the deal is the only
    // place the real company name was ever typed.
    `WITH deal_accounts AS (
       SELECT NULLIF(BTRIM(r.raw_data->'Account_Name'->>'id'), '') AS account_id,
              COUNT(*)::int AS total_deals,
              json_agg(DISTINCT NULLIF(BTRIM(r.record_name), ''))
                FILTER (WHERE NULLIF(BTRIM(r.record_name), '') IS NOT NULL) AS deal_names,
              json_agg(DISTINCT NULLIF(BTRIM(r.company_name), ''))
                FILTER (WHERE NULLIF(BTRIM(r.company_name), '') IS NOT NULL) AS deal_companies
         FROM duplicate_records r
        WHERE r.record_type = 'deal'${segCond1}
          AND NULLIF(BTRIM(r.raw_data->'Account_Name'->>'id'), '') IS NOT NULL
        GROUP BY 1
     )
     SELECT da.account_id,
            da.total_deals,
            da.deal_names,
            da.deal_companies,
            COALESCE(NULLIF(BTRIM(a.record_name), ''), da.account_id) AS account_name,
            COALESCE(NULLIF(BTRIM(a.domain), ''), NULLIF(BTRIM(a.website), '')) AS domain
       FROM deal_accounts da
       LEFT JOIN duplicate_records a
              ON a.record_type = 'account' AND a.zoho_record_id = da.account_id`,
    [...p1.params],
  );

  // The OPEN deals, keyed by account — same predicate as every other tab.
  const p2 = buildSegmentPredicate(seg, 1);
  const segCond2 = p2.condition ? " AND " + p2.condition : "";
  const dres = await pool.query(
    `SELECT NULLIF(BTRIM(r.raw_data->'Account_Name'->>'id'), '') AS account_id,
            r.zoho_record_id AS id,
            COALESCE(NULLIF(BTRIM(r.record_name),''), r.zoho_record_id) AS name,
            COALESCE(NULLIF(BTRIM(r.stage),''), r.raw_data->>'Stage', '') AS stage,
            COALESCE(NULLIF(BTRIM(r.owner_name),''), NULLIF(BTRIM(r.owner_email),''), 'Unassigned') AS owner,
            COALESCE(r.deal_value, 0)::float AS amount,
            COALESCE(NULLIF(BTRIM(r.layout_name), ''), '') AS layout,
            r.created_date AS created
       FROM duplicate_records r
      WHERE r.record_type = 'deal'
        AND (${openStagePredicate("r")})${segCond2}
        AND NULLIF(BTRIM(r.raw_data->'Account_Name'->>'id'), '') IS NOT NULL`,
    [...p2.params],
  );

  const openByAccount = new Map<string, SplitAccountDeal[]>();
  for (const d of dres.rows as any[]) {
    const k = String(d.account_id);
    const list = openByAccount.get(k) || [];
    list.push({
      id: String(d.id),
      name: String(d.name || ""),
      stage: String(d.stage || ""),
      owner: String(d.owner || ""),
      amount: Number(d.amount) || 0,
      layout: String(d.layout || ""),
      created: d.created ? String(d.created) : null,
    });
    openByAccount.set(k, list);
  }

  // Reuse the grouping by handing every account a deal list. The pure function
  // drops deal-less accounts and groups holding fewer than two deals, so a
  // dormant half of a split gets one PLACEHOLDER to keep it in the running.
  // The id must be unique per account: the grouper de-duplicates deals by id,
  // and a shared placeholder id would collapse two dormant accounts into one
  // and silently drop the group. Placeholders never reach the output — every
  // deal below is read from openByAccount, not from the group.
  const placeholder = (accountId: string): SplitAccountDeal => ({
    id: `__no_open_deal__:${accountId}`,
    name: "", stage: "", owner: "", amount: 0, layout: "", created: null,
  });
  const meta = new Map<string, { total_deals: number; domain: string | null }>();
  const sides: SplitAccountSide[] = (res.rows as any[]).map((r) => {
    const id = String(r.account_id);
    const domain = normalizeAccountDomain(r.domain);
    meta.set(id, { total_deals: Number(r.total_deals) || 0, domain });
    const aliases = [
      ...(Array.isArray(r.deal_names) ? r.deal_names : []),
      ...(Array.isArray(r.deal_companies) ? r.deal_companies : []),
    ]
      .map((x: any) => String(x || "").trim())
      .filter(Boolean);
    return {
      account_id: id,
      account_name: String(r.account_name || "").trim(),
      domain,
      deals: openByAccount.get(id) || [placeholder(id)],
      aliases,
    };
  });

  // Pairs an operator dismissed as "not the same company" stay dismissed here
  // too — sister companies should not come back through a second door.
  const separatedPairs = await getSeparationPairKeySet();
  // PROOF ONLY at this scale — see the note above groupByProof. Containment is
  // reported separately, as pairs, because chaining it across 8,985 accounts
  // merged 42 unrelated government authorities into one row.
  const grouped = groupByProof(sides, separatedPairs);
  const pairs = containmentPairs(sides, separatedPairs);

  const companies: SplitCompany[] = [];
  for (const g of grouped) {
    const accounts = g.accounts.map((a) => {
      const open = (openByAccount.get(a.account_id) || []).slice();
      return {
        account_id: a.account_id,
        account_name: a.account_name,
        domain: a.domain,
        open_deals: open,
        total_deals: meta.get(a.account_id)?.total_deals ?? 0,
      };
    });
    const withOpen = accounts.filter((a) => a.open_deals.length > 0);
    const allOpen = accounts.flatMap((a) => a.open_deals);
    const owners = Array.from(new Set(allOpen.map((d) => d.owner).filter(Boolean)));
    companies.push({
      company: g.company,
      signal: g.signal,
      classification: withOpen.length >= 2 ? "active_conflict" : "merge_needed",
      accounts,
      account_count: accounts.length,
      open_deals: allOpen.length,
      distinct_owners: owners.length,
      owners,
      total_open_value: allOpen.reduce((n, d) => n + (Number(d.amount) || 0), 0),
    });
  }

  // Conflicts first, then the biggest future problems.
  const rank = { active_conflict: 1, merge_needed: 0 } as const;
  companies.sort(
    (a, b) =>
      rank[b.classification] - rank[a.classification] ||
      b.distinct_owners - a.distinct_owners ||
      b.total_open_value - a.total_open_value ||
      b.account_count - a.account_count,
  );

  // Live collisions first: a pair where BOTH sides carry an open deal is the
  // الفران case, and it should never sit below a dormant one.
  const openCount = (id: string) => (openByAccount.get(id) || []).length;
  const possiblePairs = pairs
    .map((p) => ({
      ...p,
      a_open_deals: openCount(p.a.account_id),
      b_open_deals: openCount(p.b.account_id),
    }))
    .sort(
      (x, y) =>
        Number(y.a_open_deals > 0 && y.b_open_deals > 0) -
          Number(x.a_open_deals > 0 && x.b_open_deals > 0) ||
        y.a_open_deals + y.b_open_deals - (x.a_open_deals + x.b_open_deals),
    );

  return {
    segment: seg,
    companies,
    accounts_scanned: sides.length,
    active_conflicts: companies.filter((c) => c.classification === "active_conflict").length,
    merge_needed: companies.filter((c) => c.classification === "merge_needed").length,
    possible_pairs: possiblePairs,
  };
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
  /** Accounts whose name was too generic to match on — reported rather than
   *  dropped silently, so a shrinking list is explainable. */
  name_matching_suppressed: number;
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

  const all = Array.from(sides.values());
  // Best-effort by design: a missing ledger returns an empty set, so a problem
  // here shows every group rather than hiding one.
  const separatedPairs = await getSeparationPairKeySet();
  return {
    segment: seg,
    companies: groupSplitAccountConflicts(all, separatedPairs),
    accounts_scanned: sides.size,
    name_matching_suppressed: all.filter((s) =>
      isNonIdentifyingCompanyName(s.account_name),
    ).length,
  };
}
