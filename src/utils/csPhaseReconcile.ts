/**
 * CS PHASE RECONCILE — Zoho's live phase count against the mirror, deal by deal.
 *
 * WHY THIS EXISTS
 * Zeina Al Soudi (CS) replied to the morning CS Lifecycle post on 2026-09-13:
 * "termination 573 - 582 · New deal 17 - 18". The post, the dashboard and a
 * full-book scan all agreed on 573 / 17; Zoho said 582 / 18. Two suspects were
 * measured and cleared before this was written:
 *
 *   - the 5,000-deal scan cap — a capped and a full (11,937-deal) scan gave
 *     identical phase counts;
 *   - layout scope — WalaOne holds no termination deals, Marketplace holds 3,
 *     which cannot account for 9.
 *
 * A count cannot explain a count. What settles it is the list of DEAL IDS
 * Zoho returns for a phase, laid against what the mirror holds for each one,
 * so every missing deal lands in exactly one named bucket:
 *
 *   counted                 — in the mirror, in scope, same phase. Agrees.
 *   not_in_mirror           — Zoho has it; the sync never brought it in.
 *   excluded_by_module      — the row exists but zoho_module is not 'Deals'
 *                             (legacy rows carry NULL), and the CS scan filters
 *                             on zoho_module, so it is silently skipped.
 *   excluded_by_layout      — outside the segment the post reports on.
 *   phase_differs_in_mirror — the mirror is stale: Zoho says this phase, our
 *                             copy says another.
 *
 * And the reverse, which a one-way check would miss entirely:
 *
 *   in_mirror_not_in_zoho   — we count it under this phase; Zoho no longer
 *                             does (moved on, or deleted in the CRM).
 *
 * "In this phase" is decided by evaluateCsLifecycle — the SAME function the
 * scan and the morning post use — so "counted" means exactly what the post
 * counts, not a lookalike.
 *
 * READ-ONLY. Zoho is only read (via /search, because criteria is silently
 * ignored on the list endpoint); nothing is written to the CRM or the mirror.
 */

export interface PhaseReconcileBuckets {
  counted: number;
  not_in_mirror: string[];
  excluded_by_module: Array<{ id: string; zoho_module: string | null; record_type: string | null }>;
  excluded_by_layout: Array<{ id: string; layout: string | null }>;
  phase_differs_in_mirror: Array<{ id: string; mirror_phase: string | null }>;
  in_mirror_not_in_zoho: Array<{ id: string; name: string | null }>;
}

export interface PhaseReconcileResult {
  phase: string;
  segment: string;
  /** Deals Zoho's /search returns for this phase, all layouts. */
  zoho_count: number;
  /** True when Zoho's ~2,000-record search ceiling was reached — the Zoho side is then incomplete. */
  zoho_truncated: boolean;
  /** Deals the CS scan counts under this phase — the number the post quotes. */
  scan_count: number;
  buckets: PhaseReconcileBuckets;
  /** One line per bucket that is non-empty, in words. */
  explanation: string[];
}

/** Each list is capped in the response; the count beside it stays exact. */
const SAMPLE_CAP = 200;
/** Zoho /search: 200 per page, and it stops serving after page 10. */
const PER_PAGE = 200;
const MAX_PAGES = 10;

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

/** Escape the characters Zoho criteria treats as syntax. */
function criteriaValue(v: string): string {
  return v.replace(/([(),\\])/g, "\\$1");
}

export async function reconcileCsPhases(
  phases: string[],
  segment = "walaplus",
): Promise<PhaseReconcileResult[]> {
  const { fetchZohoRecords } = await import("./zohoCRM");
  const { pool, buildSegmentPredicate } = await import("./duplicateRadarDatabase");
  const { evaluateCsLifecycle } = await import("./csLifecycleCompliance");

  const wanted = Array.from(new Set(phases.map((p) => p.trim()).filter(Boolean)));
  if (!wanted.length) return [];

  // ── 1. Zoho, live, per phase ──────────────────────────────────────────────
  const zoho = new Map<string, { ids: Map<string, string>; truncated: boolean }>();
  for (const phase of wanted) {
    const ids = new Map<string, string>();
    let truncated = false;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const recs = await fetchZohoRecords("Deals", {
        page,
        perPage: PER_PAGE,
        fields: ["Deal_Name", "Phase", "Layout"],
        criteria: `(Phase:equals:${criteriaValue(phase)})`,
      });
      for (const r of recs as any[]) {
        ids.set(String(r.id), String(r?.data?.Deal_Name ?? ""));
      }
      if (recs.length < PER_PAGE) break;
      if (page === MAX_PAGES) truncated = true;
    }
    zoho.set(phase, { ids, truncated });
  }

  // ── 2. The mirror's copy of every one of those deals ─────────────────────
  const allIds = Array.from(
    new Set(Array.from(zoho.values()).flatMap((z) => Array.from(z.ids.keys()))),
  );
  const segment$ = buildSegmentPredicate(segment as any, 2);
  const inSegmentExpr = segment$.condition ? `(${segment$.condition})` : "TRUE";
  const mirrorRows = allIds.length
    ? (
        await pool.query(
          `SELECT r.zoho_record_id AS id, r.zoho_module, r.record_type, r.layout_name,
                  r.raw_data, r.domain, r.modified_date, r.gov_type,
                  ${inSegmentExpr} AS in_segment
             FROM duplicate_records r
            WHERE r.zoho_record_id = ANY($1::text[])`,
          [allIds, ...segment$.params],
        )
      ).rows
    : [];
  const mirrorById = new Map<string, any[]>();
  for (const row of mirrorRows as any[]) {
    const k = String(row.id);
    (mirrorById.get(k) || mirrorById.set(k, []).get(k)!).push(row);
  }

  // ── 3. The scan's own population, for the reverse direction ─────────────
  // Same WHERE as scanCsLifecycleViolations, so scan_count is the post's number.
  const pop$ = buildSegmentPredicate(segment as any, 1);
  const popRows = (
    await pool.query(
      `SELECT r.zoho_record_id AS id, r.record_name, r.raw_data, r.domain,
              r.modified_date, r.gov_type
         FROM duplicate_records r
        WHERE r.zoho_module = 'Deals'${pop$.condition ? " AND " + pop$.condition : ""}`,
      [...pop$.params],
    )
  ).rows as any[];
  const scanPhaseById = new Map<string, { phase: string; name: string | null }>();
  for (const row of popRows) {
    const ev = evaluateCsLifecycle({
      raw_data: row.raw_data,
      modified_date: row.modified_date,
      domain: row.domain,
      gov_type: row.gov_type,
    });
    if (ev.is_cs_deal && row.id) {
      scanPhaseById.set(String(row.id), { phase: norm(ev.current_phase), name: row.record_name ?? null });
    }
  }

  // ── 4. Bucket every deal, per phase ──────────────────────────────────────
  const out: PhaseReconcileResult[] = [];
  for (const phase of wanted) {
    const target = norm(phase);
    const { ids: zIds, truncated } = zoho.get(phase)!;
    const b: PhaseReconcileBuckets = {
      counted: 0,
      not_in_mirror: [],
      excluded_by_module: [],
      excluded_by_layout: [],
      phase_differs_in_mirror: [],
      in_mirror_not_in_zoho: [],
    };

    for (const id of zIds.keys()) {
      const rows = mirrorById.get(id) || [];
      if (!rows.length) {
        b.not_in_mirror.push(id);
        continue;
      }
      const deal = rows.find((r) => r.zoho_module === "Deals");
      if (!deal) {
        b.excluded_by_module.push({
          id,
          zoho_module: rows[0].zoho_module ?? null,
          record_type: rows[0].record_type ?? null,
        });
        continue;
      }
      if (!deal.in_segment) {
        b.excluded_by_layout.push({ id, layout: deal.layout_name ?? null });
        continue;
      }
      const ev = evaluateCsLifecycle({
        raw_data: deal.raw_data,
        modified_date: deal.modified_date,
        domain: deal.domain,
        gov_type: deal.gov_type,
      });
      if (!ev.is_cs_deal || norm(ev.current_phase) !== target) {
        b.phase_differs_in_mirror.push({ id, mirror_phase: ev.current_phase ?? null });
        continue;
      }
      b.counted++;
    }

    let scanCount = 0;
    for (const [id, v] of scanPhaseById) {
      if (v.phase !== target) continue;
      scanCount++;
      if (!zIds.has(id)) b.in_mirror_not_in_zoho.push({ id, name: v.name });
    }

    const explanation: string[] = [];
    const say = (n: number, text: string) => { if (n > 0) explanation.push(`${n} ${text}`); };
    say(b.not_in_mirror.length, "deal(s) exist in Zoho under this phase but were never synced into the mirror.");
    say(b.excluded_by_module.length, "deal(s) are in the mirror with the wrong or missing zoho_module, so the CS scan skips them.");
    say(b.excluded_by_layout.length, `deal(s) sit on a layout outside "${segment}", which the post does not report on.`);
    say(b.phase_differs_in_mirror.length, "deal(s) have a different phase in the mirror than in Zoho — the mirror is stale for them.");
    say(b.in_mirror_not_in_zoho.length, "deal(s) are counted under this phase by the scan but no longer carry it in Zoho.");
    // Reported because the obvious fix for excluded_by_module — widening the
    // scan to rows with a NULL zoho_module — double-counts any deal that ALSO
    // has a proper 'Deals' row. That scan feeds the dashboard, Adam and the
    // KPIs, so it must not be widened until this number is known.
    const multiRow = Array.from(zIds.keys()).filter(
      (id) => (mirrorById.get(id) || []).length > 1,
    ).length;
    say(multiRow, "deal(s) have MORE THAN ONE row in the mirror — a count over rows instead of deal IDs double-counts them.");
    if (truncated) explanation.push("Zoho's search ceiling was reached, so the Zoho-side list is incomplete.");
    if (!explanation.length) explanation.push("Zoho and the mirror agree deal for deal.");

    const cap = <T>(a: T[]) => a.slice(0, SAMPLE_CAP);
    out.push({
      phase,
      segment,
      zoho_count: zIds.size,
      zoho_truncated: truncated,
      scan_count: scanCount,
      buckets: {
        counted: b.counted,
        not_in_mirror: cap(b.not_in_mirror),
        excluded_by_module: cap(b.excluded_by_module),
        excluded_by_layout: cap(b.excluded_by_layout),
        phase_differs_in_mirror: cap(b.phase_differs_in_mirror),
        in_mirror_not_in_zoho: cap(b.in_mirror_not_in_zoho),
      },
      explanation,
    });
  }
  return out;
}
