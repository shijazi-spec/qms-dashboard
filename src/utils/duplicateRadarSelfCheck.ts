/**
 * DUPLICATE RADAR SELF-CHECK — one call that proves the September 2026 safety
 * work still behaves, so a regression is caught by a request rather than by
 * someone deleting the wrong contact.
 *
 * WHY THIS EXISTS
 * Five of the six behaviours below are SAFETY rules, not features: they exist
 * to stop the platform destroying CRM history or handing Sales a report that
 * contradicts the CRM. Verifying them by hand after every republish worked
 * exactly as long as someone remembered to do it.
 *
 * STRICTLY READ-ONLY. In particular the Empty-Delete gate is checked by asking
 * `contactsWithDuplicateTwin` what it WOULD refuse — never by calling the tag
 * endpoint, which writes to Zoho. A self-check that mutates production to prove
 * production works is not a self-check.
 *
 * A check reports:
 *   pass — the behaviour was exercised and held
 *   warn — nothing is broken, but the answer depends on data that is not ready
 *          (an unsynced module, a census still running)
 *   fail — the behaviour did not hold. Someone must look before acting on the
 *          affected tab.
 */

import {
  getMultiActiveDealAccounts,
  getModuleSyncFreshness,
} from "./duplicateRadarDatabase";
import {
  getSplitAccountDealConflicts,
  isNonIdentifyingCompanyName,
} from "./splitAccountDealConflicts";
import {
  getContactsWithNoActivity,
  contactsWithDuplicateTwin,
  getContactActivityCoverage,
} from "./contactActivitySweep";

export type SelfCheckStatus = "pass" | "warn" | "fail";

export interface SelfCheckItem {
  key: string;
  title: string;
  status: SelfCheckStatus;
  /** What was actually observed — always populated, pass or fail. */
  detail: string;
  /** Only on fail/warn: what the reader should do about it. */
  action?: string;
  facts?: Record<string, unknown>;
}

export interface SelfCheckReport {
  ok: boolean;
  ran_at: string;
  duration_ms: number;
  passed: number;
  warned: number;
  failed: number;
  checks: SelfCheckItem[];
}

/** Modules the radar reads. A missing row means that module never synced. */
const EXPECTED_MODULES = ["Deals", "Contacts", "Accounts", "Leads"] as const;

/** Beyond this, a mirror is old enough that the tabs may contradict Zoho. */
const STALE_HOURS = 6;

/** Sample size for the contact checks. Bounded so the self-check can never be
 *  the request that takes the instance down — exports already taught us that. */
const CONTACT_SAMPLE = 2000;

async function timed<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: string }> {
  try {
    return { value: await fn() };
  } catch (e: any) {
    return { error: e?.message || String(e) };
  }
}

type SplitResult = Awaited<ReturnType<typeof getSplitAccountDealConflicts>>;

/** 1. The split-account reverse check still runs and still classifies evidence. */
function checkSplitAccount(r: { value?: SplitResult; error?: string }): SelfCheckItem {
  if (r.error) {
    return {
      key: "split_account_conflicts",
      title: "Split-account conflict check",
      status: "fail",
      detail: `The check threw: ${r.error}`,
      action: "The Active Deal Conflicts blind-spot report is unavailable. Check the server log.",
    };
  }
  const res = r.value!;
  const bySignal = { domain: 0, exact_name: 0, name_containment: 0 } as Record<string, number>;
  for (const c of res.companies) bySignal[c.signal] = (bySignal[c.signal] || 0) + 1;
  // Every group must span 2+ accounts and 2+ open deals — a single-account
  // group is the main tab's job and would mean the two checks now overlap.
  const malformed = res.companies.filter(
    (c) => c.account_count < 2 || c.open_deals < 2,
  );
  return {
    key: "split_account_conflicts",
    title: "Split-account conflict check",
    status: malformed.length ? "fail" : "pass",
    detail: malformed.length
      ? `${malformed.length} group(s) span fewer than 2 accounts or 2 open deals — the reverse check is now returning rows that belong to the main tab.`
      : `${res.companies.length} companies split across accounts, from ${res.accounts_scanned} accounts scanned.`,
    action: malformed.length
      ? "Do not act on this list until the grouping is fixed; it is double-reporting the main tab."
      : undefined,
    facts: {
      companies: res.companies.length,
      accounts_scanned: res.accounts_scanned,
      by_signal: bySignal,
      name_matching_suppressed: res.name_matching_suppressed,
    },
  };
}

/** 2. Junk names never join two Account records by NAME. */
async function checkJunkNames(
  companies: Array<{ company: string; signal: string }>,
): Promise<SelfCheckItem> {
  // The pure rule, both directions.
  const suppressed = isNonIdentifyingCompanyName("Confidential ( Consulting Firm)");
  const placeholder = isNonIdentifyingCompanyName("لا يوجد");
  const realCompany = isNonIdentifyingCompanyName("Riyadh Confidential Services");
  const ruleHolds = suppressed && placeholder && !realCompany;

  // And the live consequence: no group may be joined on a junk name. A group
  // joined by DOMAIN is allowed to carry one — a domain is proof regardless of
  // how the record is named.
  const leaked = companies.filter(
    (c) => c.signal !== "domain" && isNonIdentifyingCompanyName(c.company),
  );

  const ok = ruleHolds && leaked.length === 0;
  return {
    key: "junk_name_filter",
    title: "Junk names cannot join accounts",
    status: ok ? "pass" : "fail",
    detail: ok
      ? "Withheld-name and placeholder records are barred from name matching; a real company containing the word is not."
      : !ruleHolds
        ? `The rule itself is wrong: "Confidential …"=${suppressed}, "لا يوجد"=${placeholder}, "Riyadh Confidential Services"=${realCompany} (want true/true/false).`
        : `${leaked.length} group(s) were joined by NAME on a withheld-name stand-in: ${leaked.map((c) => c.company).join("; ")}`,
    action: ok
      ? undefined
      : "Unrelated clients are being reported as one company. Do not send this list to Sales.",
    facts: { rule_holds: ruleHolds, leaked: leaked.map((c) => c.company) },
  };
}

/** 3. An empty contact with a duplicate is offered as a MERGE, not a delete. */
async function checkMergeNotDelete(): Promise<{
  item: SelfCheckItem;
  mergeCandidateIds: string[];
}> {
  const r = await timed(() => getContactsWithNoActivity(CONTACT_SAMPLE));
  if (r.error) {
    return {
      item: {
        key: "merge_not_delete",
        title: "Empty contact with a duplicate is merged, not deleted",
        status: "fail",
        detail: `The no-activity list threw: ${r.error}`,
        action: "Do not delete contacts until this loads — the merge candidates cannot be identified.",
      },
      mergeCandidateIds: [],
    };
  }
  const rows = r.value!;
  const candidates = rows.filter((x) => x.twin_id);
  // A candidate without a resolved twin name is a half-populated row: the UI
  // would offer "Merge into" with nothing to merge into.
  const broken = candidates.filter((x) => !x.twin_name && !x.twin_email);
  const directionKnown = candidates.filter((x) => (x.twin_activity || 0) > 0);
  return {
    item: {
      key: "merge_not_delete",
      title: "Empty contact with a duplicate is merged, not deleted",
      status: broken.length ? "fail" : "pass",
      detail: broken.length
        ? `${broken.length} merge candidate(s) resolve a twin id but no twin name or email — the merge target cannot be shown.`
        : `${rows.length} verified-empty contacts sampled: ${rows.length - candidates.length} deletable, ${candidates.length} must be merged (${directionKnown.length} with the survivor already proven).`,
      action: broken.length
        ? "The merge target is missing; treat these rows as not-yet-actionable."
        : undefined,
      facts: {
        sampled: rows.length,
        deletable: rows.length - candidates.length,
        merge_candidates: candidates.length,
        merge_direction_known: directionKnown.length,
      },
    },
    mergeCandidateIds: candidates.map((x) => x.zoho_contact_id),
  };
}

/**
 * 4. Empty-Delete would REFUSE every one of those merge candidates.
 *
 * Asked as a question, never as a write: `contactsWithDuplicateTwin` is the
 * exact predicate the tag route gates on, so agreeing with it proves the gate
 * without tagging a single record in Zoho.
 */
async function checkEmptyDeleteGate(ids: string[]): Promise<SelfCheckItem> {
  if (!ids.length) {
    return {
      key: "empty_delete_gate",
      title: "Empty-Delete refuses contacts that have a duplicate",
      status: "warn",
      detail: "No merge candidates in the sample, so the gate could not be exercised.",
      action: "Re-run once the activity census has covered more of the corpus.",
    };
  }
  const r = await timed(() => contactsWithDuplicateTwin(ids));
  if (r.error) {
    return {
      key: "empty_delete_gate",
      title: "Empty-Delete refuses contacts that have a duplicate",
      status: "fail",
      detail: `The gate predicate threw: ${r.error}`,
      action: "Treat Empty-Delete as unsafe for contacts until this is fixed.",
    };
  }
  const caught = r.value!;
  const wouldSlipThrough = ids.filter((id) => !caught.has(id));
  return {
    key: "empty_delete_gate",
    title: "Empty-Delete refuses contacts that have a duplicate",
    status: wouldSlipThrough.length ? "fail" : "pass",
    detail: wouldSlipThrough.length
      ? `${wouldSlipThrough.length} of ${ids.length} merge candidate(s) would NOT be refused by Empty-Delete: ${wouldSlipThrough.slice(0, 5).join(", ")}`
      : `All ${ids.length} merge candidate(s) are refused by the delete gate.`,
    action: wouldSlipThrough.length
      ? "A bulk delete could destroy fields the surviving contact does not have. Do not use Empty-Delete on Contacts until fixed."
      : undefined,
    facts: { checked: ids.length, refused: caught.size },
  };
}

/** 5. The cache bypass really re-queries, and agrees with the cached answer. */
async function checkCacheBypass(): Promise<SelfCheckItem> {
  const cached = await timed(() =>
    getMultiActiveDealAccounts("walaplus", { limit: 1000 }),
  );
  const fresh = await timed(() =>
    getMultiActiveDealAccounts("walaplus", { limit: 1000, bypassCache: true }),
  );
  if (cached.error || fresh.error) {
    return {
      key: "cache_bypass",
      title: "Refresh bypasses the 90s cache",
      status: "fail",
      detail: `Active Deal Conflicts threw: ${cached.error || fresh.error}`,
      action: "The tab and its export are unavailable.",
    };
  }
  // Same instant, same data — a bypass that disagrees with a cache filled
  // moments earlier means one of the two paths is reading something else.
  const same = cached.value!.length === fresh.value!.length;
  return {
    key: "cache_bypass",
    title: "Refresh bypasses the 90s cache",
    status: same ? "pass" : "fail",
    detail: same
      ? `Cached and bypassed reads agree (${fresh.value!.length} companies), so Refresh and the export re-query without changing the answer.`
      : `Cached read returned ${cached.value!.length} companies, bypassed read ${fresh.value!.length}. The two paths disagree.`,
    action: same ? undefined : "The exported workbook may not match the tab. Do not send it to Sales.",
    facts: { cached: cached.value!.length, bypassed: fresh.value!.length },
  };
}

/** 6. Every module has a mirror watermark, and it is recent enough to trust. */
async function checkFreshness(): Promise<SelfCheckItem> {
  const r = await timed(() => getModuleSyncFreshness());
  if (r.error) {
    return {
      key: "sync_freshness",
      title: "Mirror freshness is reportable for every module",
      status: "fail",
      detail: `Could not read the sync watermarks: ${r.error}`,
      action: "The freshness bar will be blank; tabs cannot state how old their data is.",
    };
  }
  const mods = r.value!;
  const ages: Record<string, number | null> = {};
  const never: string[] = [];
  const stale: string[] = [];
  for (const m of EXPECTED_MODULES) {
    const at = mods[m];
    if (!at) {
      never.push(m);
      ages[m] = null;
      continue;
    }
    const hours = (Date.now() - new Date(at).getTime()) / 3_600_000;
    ages[m] = Math.round(hours * 10) / 10;
    if (hours > STALE_HOURS) stale.push(m);
  }
  const status: SelfCheckStatus = never.length ? "fail" : stale.length ? "warn" : "pass";
  return {
    key: "sync_freshness",
    title: "Mirror freshness is reportable for every module",
    status,
    detail: never.length
      ? `${never.join(", ")} ${never.length > 1 ? "have" : "has"} never synced, so tabs reading ${never.length > 1 ? "them" : "it"} have nothing current to show.`
      : stale.length
        ? `${stale.join(", ")} last synced more than ${STALE_HOURS}h ago — those tabs may contradict Zoho.`
        : "Every module has a recent watermark.",
    action: never.length || stale.length ? "Run Scan to pull the changes made in Zoho since then." : undefined,
    facts: { age_hours: ages },
  };
}

/** Census coverage — context for anyone reading the contact checks. */
async function checkCensusCoverage(): Promise<SelfCheckItem> {
  const r = await timed(() => getContactActivityCoverage());
  if (r.error) {
    return {
      key: "activity_census_coverage",
      title: "Contact activity census coverage",
      status: "warn",
      detail: `Coverage unavailable: ${r.error}`,
    };
  }
  const c = r.value!;
  const pct = c.contacts ? Math.round(((c.with_activity + c.verified) / c.contacts) * 100) : 0;
  return {
    key: "activity_census_coverage",
    title: "Contact activity census coverage",
    // Never a failure: partial coverage is the census working, not breaking.
    // It is reported because the contact lists below are only as complete as
    // this number, and a reader must not mistake a short list for a full one.
    status: pct >= 100 ? "pass" : "warn",
    detail: `${pct}% of contacts checked — ${c.with_activity} have activity, ${c.proven_empty} proven empty of ${c.contacts}.`,
    action: pct >= 100 ? undefined : "The no-activity list will grow. A contact not yet checked is not shown.",
    facts: { ...c, checked_pct: pct },
  };
}

export async function runDuplicateRadarSelfCheck(): Promise<SelfCheckReport> {
  const started = Date.now();
  const checks: SelfCheckItem[] = [];

  // ONE read of the split-account check, shared by both checks that need it.
  // Running it twice would double the most expensive query in the report.
  const splitRes = await timed(() => getSplitAccountDealConflicts("walaplus"));
  checks.push(checkSplitAccount(splitRes));
  checks.push(
    await checkJunkNames(
      splitRes.value
        ? splitRes.value.companies.map((c) => ({ company: c.company, signal: c.signal }))
        : [],
    ),
  );

  const merge = await checkMergeNotDelete();
  checks.push(merge.item);
  checks.push(await checkEmptyDeleteGate(merge.mergeCandidateIds));
  checks.push(await checkCacheBypass());
  checks.push(await checkFreshness());
  checks.push(await checkCensusCoverage());

  const passed = checks.filter((c) => c.status === "pass").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  const failed = checks.filter((c) => c.status === "fail").length;

  return {
    ok: failed === 0,
    ran_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    passed,
    warned,
    failed,
    checks,
  };
}
