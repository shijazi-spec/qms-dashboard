export interface DealComplianceRow {
  stage: string;
  compliant: boolean;
  amount: number;
  owner: string;
  missing_docs: Array<string | { key?: string; label?: string }> | null;
}
export interface DealComplianceSummary {
  segment: string;
  checked: number;
  compliant: number;
  compliant_rate: number | null;
  at_risk_sar: number;
  by_stage: Array<{ stage: string; checked: number; compliant: number; missing: number }>;
  by_owner: Array<{ owner: string; checked: number; compliant: number; missing: number }>;
  owner_overflow: number;
  top_missing_docs: Array<{ label: string; count: number }>;
}

/** PURE aggregation of per-deal doc-compliance rows into the BU report shape. */
export function shapeDealCompliance(segment: string, rows: DealComplianceRow[]): DealComplianceSummary {
  let checked = 0, compliant = 0, atRisk = 0;
  const byStage = new Map<string, { checked: number; compliant: number }>();
  const byOwner = new Map<string, { checked: number; compliant: number }>();
  const missing = new Map<string, number>();

  for (const r of rows || []) {
    checked++;
    const isC = r.compliant === true;
    if (isC) compliant++; else atRisk += Number(r.amount) || 0;

    const st = (r.stage && String(r.stage).trim()) || "Unknown";
    const s = byStage.get(st) || { checked: 0, compliant: 0 };
    s.checked++; if (isC) s.compliant++; byStage.set(st, s);

    const ow = (r.owner && String(r.owner).trim()) || "Unassigned";
    const o = byOwner.get(ow) || { checked: 0, compliant: 0 };
    o.checked++; if (isC) o.compliant++; byOwner.set(ow, o);

    if (!isC && Array.isArray(r.missing_docs)) {
      for (const m of r.missing_docs) {
        const lbl = typeof m === "string"
          ? (m.trim() || "Unknown")
          : ((m && m.label && String(m.label).trim()) || (m && m.key ? String(m.key) : "Unknown"));
        missing.set(lbl, (missing.get(lbl) || 0) + 1);
      }
    }
  }

  const by_stage = Array.from(byStage, ([stage, v]) => ({ stage, checked: v.checked, compliant: v.compliant, missing: v.checked - v.compliant }))
    .sort((a, b) => b.missing - a.missing);
  const allOwners = Array.from(byOwner, ([owner, v]) => ({ owner, checked: v.checked, compliant: v.compliant, missing: v.checked - v.compliant }))
    .sort((a, b) => b.missing - a.missing);
  const by_owner = allOwners.slice(0, 10);
  const owner_overflow = Math.max(0, allOwners.length - by_owner.length);
  const top_missing_docs = Array.from(missing, ([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);

  return {
    segment, checked, compliant,
    compliant_rate: checked ? Math.round((100 * compliant) / checked) : null,
    at_risk_sar: Math.round(atRisk),
    by_stage, by_owner, owner_overflow, top_missing_docs,
  };
}
