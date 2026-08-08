import { getBUByKey, type QualityReportBU } from "./qualityReportsDepartments";
import { logger } from "./logger";

export function functionReportKeys(fn: string): string[] {
  switch (fn) {
    case "sdr": return ["leads"];
    case "sales": return ["deals", "stage_aging"]; // deal_compliance deferred to Phase 2 (no segment-level engine yet)
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
}

// Best-effort runner: never let one section throw the whole page. Records the
// section name in notConfigured when it's unmapped or errors.
async function section<T>(
  name: string, enabled: boolean, run: () => Promise<T>, notConfigured: string[],
): Promise<T | null> {
  if (!enabled) { notConfigured.push(name); return null; }
  try { return await run(); }
  catch (e) { logger.warn(`[QualityReports] section ${name} failed`, { error: e instanceof Error ? e.message : String(e) }); notConfigured.push(name); return null; }
}

export async function getBUReport(buKey: string): Promise<BUReport | null> {
  const bu = await getBUByKey(buKey);
  if (!bu) return null;
  const notConfigured: string[] = [];
  const keys = functionReportKeys(bu.fn);

  // Lazy imports keep the module graph light + avoid load-time cycles.
  const DRD = await import("./duplicateRadarDatabase");
  const policyDb = await import("./policyDatabase");
  const kpiDb = await import("./kpiChecklistDatabase");
  const qmsDb = await import("./qmsDatabase");

  // getAllPolicies returns { policies, total } (policyDatabase.ts:413) — pass
  // the whole shape through rather than assuming a bare array or `.records`.
  const sops = await section("sops", !!bu.policy_department, async () => {
    const res = await policyDb.getAllPolicies({ owner_department: bu.policy_department as string });
    return res;
  }, notConfigured);

  // getFrameworkProgressByBU returns Record<buName,{done,total,pct}> keyed by
  // the QM-KPI-015 checklist section name (kpiChecklistDatabase.ts:704).
  const kpis = await section("kpis", !!bu.kpi_bu_name, async () => {
    const all = await kpiDb.getFrameworkProgressByBU();
    return all[bu.kpi_bu_name as string] || { done: 0, total: 0, pct: 0 };
  }, notConfigured);

  const cleanup = await section("cleanup", keys.some((k) => k === "deals" || k === "leads"), async () => {
    const out: any = {};
    if (keys.includes("deals")) out.deals = await DRD.getDataCleaningProgress(bu.segment);
    if (keys.includes("leads")) {
      // Lead duplicates in this segment: non-primary lead members of active
      // dup clusters. getDataCleaningProgress only covers Deals/Accounts, so
      // leads get their own light counter (Step 4 helper below).
      out.leads = await DRD.getSegmentLeadDuplicateCount(bu.segment);
    }
    return out;
  }, notConfigured);

  const compliance = await section("compliance", keys.some((k) => k.startsWith("cs_lifecycle") || k === "stage_aging"), async () => {
    const out: any = {};
    if (keys.includes("cs_lifecycle") || keys.includes("cs_lifecycle_onboarding")) {
      out.cs = await DRD.scanCsLifecycleViolations({ segment: bu.segment });
      if (keys.includes("cs_lifecycle_onboarding")) out.phaseFocus = "Onboarding";
    }
    if (keys.includes("stage_aging")) out.stageAging = await DRD.scanDealStageAgingViolations({ segment: bu.segment });
    return out;
  }, notConfigured);

  const actions = await section("actions", bu.owners.length > 0, async () => {
    const owners = new Set(bu.owners.map((o) => o.toLowerCase()));
    // getCapaRecords returns { records, total }; each CapaRecord carries
    // `assigned_to` (qmsDatabase.ts:229/577) — matches the brief's field access.
    // Large limit: getCapaRecords defaults to 50, but we filter to this BU's
    // owners in-memory below, so we must fetch the full open-CAPA set or older
    // open CAPAs for this BU would be silently dropped (understated count).
    const capaRes = await qmsDb.getCapaRecords({ status: "open", limit: 5000 });
    const capas = (capaRes.records || []).filter((r: any) =>
      r.assigned_to && owners.has(String(r.assigned_to).toLowerCase()));
    const acct = await DRD.getOwnerAccountability();
    const ownerRows = (acct || []).filter((a: any) =>
      a.owner_email && owners.has(String(a.owner_email).toLowerCase()));
    return { openCapas: capas.length, capas, ownerAccountability: ownerRows };
  }, notConfigured);

  return { bu, sections: { sops, kpis, cleanup, compliance, actions }, notConfigured };
}
