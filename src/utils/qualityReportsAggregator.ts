import { getBUByKey, type QualityReportBU } from "./qualityReportsDepartments";
import { logger } from "./logger";

export function functionReportKeys(fn: string): string[] {
  switch (fn) {
    case "sdr": return ["leads"];
    case "sales": return ["deals", "deal_compliance", "stage_aging"];
    case "cs":
    case "partnersuccess": return ["cs_lifecycle"];
    case "partnership": return ["leads", "deals"];
    case "onboarding": return ["cs_lifecycle_onboarding", "deals"];
    default: return [];
  }
}

export interface BUReport {
  bu: QualityReportBU;
  sections: { sops: any; kpis: any; cleanup: any; compliance: any; actions: any };
  notConfigured: string[];
  /**
   * Sections that exceeded SECTION_TIMEOUT_MS. Kept SEPARATE from
   * notConfigured so the UI can say "timed out, retry" instead of mislabelling
   * a slow-but-mapped section as "not configured yet".
   */
  timedOut: string[];
}

/**
 * Per-section wall-clock budget. The whole point is that a slow section
 * degrades to a placeholder card while the rest of the page renders, instead
 * of the entire request hanging until the Replit proxy returns a 504 with no
 * diagnostic at all (which is exactly what /quality-reports did).
 *
 * Sections run in PARALLEL, so this is close to the whole request's ceiling,
 * not a per-section budget that stacks.
 */
const SECTION_TIMEOUT_MS = Math.max(
  1000,
  parseInt(process.env.QUALITY_REPORTS_SECTION_TIMEOUT_MS ?? "20000", 10) || 20000,
);

class SectionTimeout extends Error {
  constructor(name: string, ms: number) {
    super(`section ${name} exceeded ${ms}ms`);
    this.name = "SectionTimeout";
  }
}

/**
 * NOTE: this bounds how long we WAIT, not the query itself — node-postgres
 * gives no cancel handle here, so an over-budget query keeps running and only
 * releases its pool connection when it finishes. That's acceptable as a
 * backstop (the user gets a page either way); the pool-level statement_timeout
 * in duplicateRadarDatabase.ts is what actually kills a true runaway.
 */
function withTimeout<T>(name: string, ms: number, run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SectionTimeout(name, ms)), ms);
    run().then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// Best-effort runner: never let one section throw the whole page. Records the
// section name in notConfigured when it's unmapped or errors, in timedOut when
// it blew the budget.
async function section<T>(
  name: string, enabled: boolean, run: () => Promise<T>,
  notConfigured: string[], timedOut: string[],
): Promise<T | null> {
  if (!enabled) { notConfigured.push(name); return null; }
  const t0 = Date.now();
  try {
    const out = await withTimeout(name, SECTION_TIMEOUT_MS, run);
    logger.info(`[QualityReports] section ${name} ok`, { ms: Date.now() - t0 });
    return out;
  } catch (e) {
    if (e instanceof SectionTimeout) {
      logger.warn(`[QualityReports] section ${name} TIMED OUT`, { ms: Date.now() - t0, budgetMs: SECTION_TIMEOUT_MS });
      timedOut.push(name);
      return null;
    }
    logger.warn(`[QualityReports] section ${name} failed`, { ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) });
    notConfigured.push(name);
    return null;
  }
}

export async function getBUReport(buKey: string): Promise<BUReport | null> {
  const tStart = Date.now();
  const bu = await getBUByKey(buKey);
  if (!bu) return null;
  const notConfigured: string[] = [];
  const timedOut: string[] = [];
  const keys = functionReportKeys(bu.fn);

  // Lazy imports keep the module graph light + avoid load-time cycles.
  const DRD = await import("./duplicateRadarDatabase");
  const policyDb = await import("./policyDatabase");
  const kpiDb = await import("./kpiChecklistDatabase");
  const qmsDb = await import("./qmsDatabase");

  // getAllPolicies returns { policies, total } (policyDatabase.ts:413) — pass
  // the whole shape through rather than assuming a bare array or `.records`.
  // The five sections are INDEPENDENT — each hits different tables and none
  // consumes another's output. They used to run as five sequential awaits, so
  // the request cost the SUM of every scan; now it costs the slowest one.
  const sops = section("sops", !!bu.policy_department, async () => {
    const res = await policyDb.getAllPolicies({ owner_department: bu.policy_department as string });
    return res;
  }, notConfigured, timedOut);

  // Two DIFFERENT things live under "kpis", and conflating them is what made
  // this card read "0% (0/0)" on a BU that has six live KPIs:
  //
  //   framework — QM-KPI-015 action-plan CHECKLIST progress for the mapped
  //               checklist BU (getFrameworkProgressByBU returns
  //               Record<buName,{done,total,pct}>, kpiChecklistDatabase.ts:704).
  //               This is "how much of the rollout plan is done".
  //   list      — the actual KPI CATALOG rows for the BU's owning team
  //               (SDR-KPI-01..06 etc.), most of them auto-calculated from
  //               CRM by kpiProcessCalc.ts. This is "how the team is
  //               performing".
  //
  // Sarah 2026-08-16 asked for the performance KPIs here, and to keep the
  // checklist too — so the section carries both and the UI labels them.
  // Mapped independently: a BU can have one, both, or neither.
  const kpis = section("kpis", !!bu.kpi_bu_name || !!bu.kpi_owner_name, async () => {
    const [framework, list] = await Promise.all([
      bu.kpi_bu_name
        ? kpiDb.getFrameworkProgressByBU().then(
            (all: any) => all[bu.kpi_bu_name as string] || { done: 0, total: 0, pct: 0 },
          )
        : Promise.resolve(null),
      bu.kpi_owner_name
        ? import("./kpiDatabase").then((m) =>
            m.getKPIsWithValuesByOwnerName(bu.kpi_owner_name as string),
          )
        : Promise.resolve([]),
    ]);
    return {
      framework,                       // null when no checklist BU mapped
      owner: bu.kpi_owner_name ?? null,
      list,                            // [] when no KPI owner mapped
      // Deliberately NOT called `total` — the framework spread below also
      // carries a `total` (checklist items), and letting the two share a key
      // makes the number silently mean whichever spread landed last.
      kpiCount: list.length,
      kpiMeasured: list.filter((k: any) => k.current_value !== null).length,
      kpiOnTarget: list.filter((k: any) => k.rag === "green").length,
      // Back-compat: the hub headline + email template read done/total/pct
      // off this section. Keep them pointing at the CHECKLIST so existing
      // consumers don't silently change meaning.
      ...(framework || { done: 0, total: 0, pct: 0 }),
    };
  }, notConfigured, timedOut);

  const cleanup = section("cleanup", keys.some((k) => k === "deals" || k === "leads"), async () => {
    const out: any = {};
    if (keys.includes("deals")) out.deals = await DRD.getDataCleaningProgress(bu.segment);
    if (keys.includes("leads")) {
      // Lead duplicates in this segment: non-primary lead members of active
      // dup clusters. getDataCleaningProgress only covers Deals/Accounts, so
      // leads get their own light counter (Step 4 helper below).
      out.leads = await DRD.getSegmentLeadDuplicateCount(bu.segment);
    }
    return out;
  }, notConfigured, timedOut);

  // summaryOnly on both scans: this report renders ONE integer from each
  // (summary.total_violations) — the full violation lists were megabytes of
  // JSON built, shipped and parsed for nothing. The three calls inside are
  // independent of each other too, so they run concurrently.
  const compliance = section("compliance", keys.some((k) => k.startsWith("cs_lifecycle") || k === "deal_compliance" || k === "stage_aging"), async () => {
    const wantCs = keys.includes("cs_lifecycle") || keys.includes("cs_lifecycle_onboarding");
    const [cs, dealCompliance, stageAging] = await Promise.all([
      wantCs ? DRD.scanCsLifecycleViolations({ segment: bu.segment, summaryOnly: true }) : Promise.resolve(null),
      keys.includes("deal_compliance") ? DRD.getSegmentDealComplianceSummary(bu.segment) : Promise.resolve(null),
      keys.includes("stage_aging") ? DRD.scanDealStageAgingViolations({ segment: bu.segment, summaryOnly: true }) : Promise.resolve(null),
    ]);
    const out: any = {};
    if (cs) {
      out.cs = cs;
      if (keys.includes("cs_lifecycle_onboarding")) out.phaseFocus = "Onboarding";
    }
    if (dealCompliance) out.dealCompliance = dealCompliance;
    if (stageAging) out.stageAging = stageAging;
    return out;
  }, notConfigured, timedOut);

  const actions = section("actions", bu.owners.length > 0, async () => {
    const owners = new Set(bu.owners.map((o) => o.toLowerCase()));
    // getCapaRecords returns { records, total }; each CapaRecord carries
    // `assigned_to` (qmsDatabase.ts:229/577) — matches the brief's field access.
    // Large limit: getCapaRecords defaults to 50, but we filter to this BU's
    // owners in-memory below, so we must fetch the full open-CAPA set or older
    // open CAPAs for this BU would be silently dropped (understated count).
    // Independent queries — getOwnerAccountability is a full GROUP BY over
    // duplicate_records, so overlapping it with the CAPA fetch is free time.
    const [capaRes, acct] = await Promise.all([
      qmsDb.getCapaRecords({ status: "open", limit: 5000 }),
      DRD.getOwnerAccountability(),
    ]);
    const capas = (capaRes.records || []).filter((r: any) =>
      r.assigned_to && owners.has(String(r.assigned_to).toLowerCase()));
    const ownerRows = (acct || []).filter((a: any) =>
      a.owner_email && owners.has(String(a.owner_email).toLowerCase()));
    return { openCapas: capas.length, capas, ownerAccountability: ownerRows };
  }, notConfigured, timedOut);

  const [sopsR, kpisR, cleanupR, complianceR, actionsR] =
    await Promise.all([sops, kpis, cleanup, compliance, actions]);

  logger.info("[QualityReports] report built", {
    buKey, fn: bu.fn, segment: bu.segment, ms: Date.now() - tStart,
    notConfigured, timedOut,
  });

  return {
    bu,
    sections: { sops: sopsR, kpis: kpisR, cleanup: cleanupR, compliance: complianceR, actions: actionsR },
    notConfigured,
    timedOut,
  };
}

export interface BUHeadline {
  bu_key: string;
  sops: number | null;
  kpiPct: number | null;
  outstanding: number;
  openCapas: number | null;
}

/** Cheap per-BU headline for the hub cards — counts only, NO heavy violation scans. */
export async function getBUHeadline(buKey: string): Promise<BUHeadline | null> {
  const bu = await getBUByKey(buKey);
  if (!bu) return null;
  const DRD = await import("./duplicateRadarDatabase");
  const policyDb = await import("./policyDatabase");
  const kpiDb = await import("./kpiChecklistDatabase");
  const qmsDb = await import("./qmsDatabase");

  const safe = async <T>(run: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await run(); } catch { return fallback; }
  };

  // SOPs count (null if unmapped).
  const sops = bu.policy_department
    ? await safe(async () => (await policyDb.getAllPolicies({ owner_department: bu.policy_department as string } as any)).policies.length, null as number | null)
    : null;

  // KPI pct (null if unmapped).
  const kpiPct = bu.kpi_bu_name
    ? await safe(async () => {
        const all = await kpiDb.getFrameworkProgressByBU();
        const e = all[bu.kpi_bu_name as string];
        return e ? e.pct : null;
      }, null as number | null)
    : null;

  // Outstanding dup count — leads for sdr, deals otherwise. Always available.
  const outstanding = await safe(async () => {
    if (bu.fn === "sdr") return (await DRD.getSegmentLeadDuplicateCount(bu.segment)).outstanding_leads;
    return (await DRD.getSegmentDealDuplicateCount(bu.segment)).outstanding_deals;
  }, 0);

  // Open CAPAs for this BU's owners (null if no owners mapped).
  const openCapas = bu.owners.length
    ? await safe(async () => {
        const owners = new Set(bu.owners.map((o) => o.toLowerCase()));
        const res = await qmsDb.getCapaRecords({ status: "open", limit: 5000 });
        return (res.records || []).filter((r: any) => r.assigned_to && owners.has(String(r.assigned_to).toLowerCase())).length;
      }, null as number | null)
    : null;

  return { bu_key: bu.bu_key, sops, kpiPct, outstanding, openCapas };
}
