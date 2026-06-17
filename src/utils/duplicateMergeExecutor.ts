/**
 * Duplicate Resolution — EXECUTOR (Phase 1, Accounts, migrate-then-tag).
 *
 * Consumes a MergePlan (from duplicateMergePlanner) and applies it to Zoho.
 * The platform NEVER deletes — it migrates winning fields onto the survivor,
 * reparents the duplicates' related records, tags each duplicate
 * `Duplicate-Delete`, and stamps audit notes; a human admin deletes the tagged
 * records later.
 *
 * SAFETY:
 *   • `dryRun` (default) performs NO writes — it still enumerates related
 *     records (read-only) so the report shows exactly what a real run would do.
 *   • A real run captures a full pre-write snapshot (all records incl. raw_data)
 *     for rollback BEFORE any mutation.
 *   • Every Zoho call is wrapped — one failure is recorded and the run
 *     continues, so a partial failure is fully reported rather than silent.
 *   • Reliable reparenting (Deals / Contacts via Account_Name lookup, Notes via
 *     copy) is performed. Activities (Tasks/Calls/Events) and Attachments are
 *     enumerated and reported as "left on the duplicate" — Zoho v2 has no
 *     reliable move for them, so they stay until the admin deletes the record.
 */

import type { MergePlan, CrmModule } from "./duplicateMergePlanner";
import {
  updateZohoRecord,
  fetchZohoRelatedRecords,
  fetchZohoRecordById,
  addZohoTags,
  addZohoNote,
  zohoWritesAllowedInEnv,
} from "./zohoCRM";

// Re-exported so existing callers (autonomous runner) keep importing the env
// gate from here; the single source of truth lives in zohoCRM.
export { zohoWritesAllowedInEnv } from "./zohoCRM";
import {
  captureClusterSnapshot,
  resolveCluster,
  markPrimaryRecord,
  recordPartialMergeAction,
  recordResolutionLedgerEntry,
  markRecordStalePending,
} from "./duplicateRadarDatabase";
import { logger } from "./logger";

/**
 * Zoho returns 400 "the related id given seems to be invalid" when the
 * referenced record has already been deleted on their side. Our local
 * duplicate_records table is then carrying a ghost — every per-record
 * operation against that id (fetch related list, stamp note, write
 * lookup) will keep 400-ing. Detect the pattern so the executor can
 * mark it stale and stop trying to act on it.
 *
 * Match is case-insensitive on the exact wording Zoho ships in the
 * response body so unrelated 400s (rate limit, malformed payload) keep
 * surfacing as real errors.
 */
export function isGhostRecordError(e: unknown): boolean {
  if (!e) return false;
  const msg = e instanceof Error ? e.message : String(e);
  return /the related id given seems to be invalid/i.test(msg);
}

export interface ExecuteReport {
  dryRun: boolean;
  clusterId: number;
  master: { zohoId: string | null; name: string };
  fieldsMigrated: Array<{ field: string; value: string | number | null }>;
  reparented: { deals: number; contacts: number; notes: number };
  /** Account the survivor was linked to via Account_Name (Contacts/Deals), or null. */
  linkedToAccount: string | null;
  leftOnDuplicate: { activities: number; attachments: number };
  taggedRecordIds: string[];
  notesStamped: number;
  clusterResolved: boolean;
  warnings: string[];
  errors: Array<{ step: string; recordId?: string; message: string }>;
  /** Duplicate Zoho ids the executor detected as already-deleted in Zoho
   *  (Zoho 400 "the related id given seems to be invalid"). They were
   *  tagged stale_pending locally and the next sync's cleanup pass will
   *  purge them from duplicate_records. Surfaced as a single info-level
   *  warning instead of a wall of red errors. */
  staleDropped: string[];
}

export interface ExecuteOptions {
  performedBy: string;
  /** Default true — must be explicitly set false (operator confirm) to write. */
  dryRun?: boolean;
  /**
   * Whether to mark the whole cluster resolved after the Account writes.
   * Default true. Set FALSE for cross-module clusters — Agentic Resolution
   * touches Accounts only, so closing the cluster would drop it from the
   * active list before the remaining modules (Leads / Deals / Contacts)
   * have been actioned via their own Agentic Resolution sections. The
   * cluster auto-flips to resolved once the next sync detects every
   * module's duplicates as merged/tagged in Zoho.
   */
  closeCluster?: boolean;
}

const ACTIVITY_LISTS = ["Tasks", "Calls", "Events"];

// Per-module reparenting: which related lists to repoint onto the survivor and
// via which lookup field. Notes are always copied (handled separately);
// activities/attachments are enumerated only (no reliable Zoho v2 move).
//   Accounts: child Deals + Contacts repoint their Account_Name lookup.
//   Contacts: related Deals repoint their Contact_Name lookup.
//   Leads / Deals: no lookup children to repoint (Notes copy only).
const MODULE_REPARENT: Record<
  CrmModule,
  Array<{ list: string; module: string; lookup: string; bucket: "deals" | "contacts" }>
> = {
  Accounts: [
    { list: "Deals", module: "Deals", lookup: "Account_Name", bucket: "deals" },
    { list: "Contacts", module: "Contacts", lookup: "Account_Name", bucket: "contacts" },
  ],
  Contacts: [
    { list: "Deals", module: "Deals", lookup: "Contact_Name", bucket: "deals" },
  ],
  Leads: [],
  Deals: [],
};

export async function executeMergePlan(
  plan: MergePlan,
  opts: ExecuteOptions,
): Promise<ExecuteReport> {
  const dryRun = opts.dryRun !== false; // safe default: dry-run unless told otherwise

  // Central kill switch: refuse REAL writes outside production. This protects
  // every caller (manual Apply route + autonomous runner) from mutating the
  // shared live Zoho org from dev. Dry-run is always allowed (it never writes).
  if (!dryRun && !zohoWritesAllowedInEnv()) {
    throw new Error(
      "Live Zoho writes are blocked outside production (dev shares production's Zoho credentials). " +
        "Apply from the deployed app, or set RESOLUTION_ALLOW_WRITES_OUTSIDE_PROD=true only for a dedicated non-prod Zoho org.",
    );
  }
  const performedBy = opts.performedBy || "duplicate-radar";
  const module = plan.module; // "Accounts"
  const masterId = plan.masterZohoId;
  const dups = plan.duplicateZohoIds;

  const report: ExecuteReport = {
    dryRun,
    clusterId: plan.clusterId,
    master: { zohoId: masterId, name: plan.masterName },
    fieldsMigrated: [],
    reparented: { deals: 0, contacts: 0, notes: 0 },
    linkedToAccount: null,
    leftOnDuplicate: { activities: 0, attachments: 0 },
    taggedRecordIds: [],
    notesStamped: 0,
    clusterResolved: false,
    warnings: [...plan.warnings],
    errors: [],
    staleDropped: [],
  };

  // Ghost-id ledger: once a Zoho id 400s with "invalid related id", every
  // subsequent op against the same id is skipped silently and the id is
  // tagged stale_pending in our DB so the next sync cleanup purges it.
  const ghostIds = new Set<string>();
  const markGhost = (recordId: string) => {
    if (ghostIds.has(recordId)) return;
    ghostIds.add(recordId);
    report.staleDropped.push(recordId);
    if (!dryRun) {
      // Fire-and-forget — DB write must not block the agentic run.
      markRecordStalePending(module, recordId).catch((dbErr) => {
        logger.warn("[merge-executor] mark-stale-pending failed", {
          recordId,
          error: dbErr instanceof Error ? dbErr.message : String(dbErr),
        });
      });
    }
  };

  const fail = (step: string, e: unknown, recordId?: string) => {
    if (recordId && isGhostRecordError(e)) {
      markGhost(recordId);
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    report.errors.push({ step, recordId, message });
    logger.error(`[merge-executor] ${step} failed`, { recordId, message });
  };

  if (!masterId) {
    report.warnings.push(
      "Survivor has no Zoho record id — cannot execute. Resolve the cluster manually.",
    );
    return report;
  }

  // 0) Snapshot BEFORE any write (rollback source). Best-effort.
  if (!dryRun) {
    try {
      await captureClusterSnapshot(plan.clusterId, performedBy, "pre_agentic_merge", {
        notes: `Agentic merge into ${masterId}; ${dups.length} duplicate(s) to be tagged ${plan.tagName}.`,
      });
    } catch (e) {
      fail("snapshot", e);
    }
  }

  // 1) Migrate winning field values onto the survivor (gap-fills only).
  const fills = plan.fieldDecisions.filter((d) => d.action === "fill");
  if (fills.length > 0) {
    const updates: Record<string, unknown> = {};
    for (const f of fills) updates[f.field] = f.chosenValue;
    report.fieldsMigrated = fills.map((f) => ({ field: f.field, value: f.chosenValue }));
    if (!dryRun) {
      try {
        await updateZohoRecord(module, masterId, updates);
      } catch (e) {
        fail("migrate-fields", e, masterId);
      }
    }
  }

  // 1b) Cross-module link — set Account_Name on the survivor AND on every
  // contact in the cluster (Contacts / Deals only). Three groups: the
  // survivor, the duplicates (which will also be tagged Duplicate-Delete),
  // and the "cascade-only" set (Contacts soft-excluded by the strict ≥2-
  // attribute rule — they are NOT duplicates of the survivor but they
  // still belong to the surviving Account). Tagging a contact for deletion
  // doesn't erase it from Zoho; the admin reviews each tagged record before
  // flipping the delete switch and needs to see the right parent Account on
  // every row. Failures on a single record are tracked but do not abort.
  if (plan.linkAccountZohoId && (module === "Contacts" || module === "Deals")) {
    report.linkedToAccount = plan.linkAccountZohoId;
    if (!dryRun) {
      try {
        await updateZohoRecord(module, masterId, {
          Account_Name: { id: plan.linkAccountZohoId },
        });
      } catch (e) {
        fail("link-account", e, masterId);
      }
      for (const dupId of dups) {
        if (ghostIds.has(dupId)) continue;
        try {
          await updateZohoRecord(module, dupId, {
            Account_Name: { id: plan.linkAccountZohoId },
          });
        } catch (e) {
          fail("link-account-duplicate", e, dupId);
        }
      }
      // Cascade-only: NOT tagged, just re-pointed under the surviving Account.
      for (const cascadeId of plan.cascadeOnlyZohoIds || []) {
        try {
          await updateZohoRecord(module, cascadeId, {
            Account_Name: { id: plan.linkAccountZohoId },
          });
        } catch (e) {
          fail("link-account-cascade-only", e, cascadeId);
        }
      }
    }
  }

  // 2) Reparent each duplicate's related records onto the survivor.
  for (const dupId of dups) {
    if (ghostIds.has(dupId)) continue;
    // Module-specific lookup children (Accounts→Deals/Contacts via Account_Name;
    // Contacts→Deals via Contact_Name; Leads/Deals→none). Repoint the lookup.
    for (const rp of MODULE_REPARENT[module]) {
      try {
        const children = await fetchZohoRelatedRecords(module, dupId, rp.list, { perPage: 200 });
        for (const ch of children) {
          if (!dryRun) {
            try {
              await updateZohoRecord(rp.module, ch.id, { [rp.lookup]: { id: masterId } });
            } catch (e) {
              fail("reparent-" + rp.list.toLowerCase(), e, ch.id);
              continue;
            }
          }
          report.reparented[rp.bucket]++;
        }
      } catch (e) {
        fail("fetch-" + rp.list.toLowerCase(), e, dupId);
      }
    }

    // Notes — Zoho v2 cannot move a note's parent, so copy onto the survivor.
    try {
      const notes = await fetchZohoRelatedRecords(module, dupId, "Notes", { perPage: 200 });
      for (const nt of notes) {
        const title = (nt.data?.Note_Title as string) || "Note (migrated)";
        const content =
          ((nt.data?.Note_Content as string) || "") +
          `\n\n[Migrated from duplicate ${dupId} by QMS Agentic Resolution]`;
        if (!dryRun) {
          try {
            await addZohoNote(module, masterId, title, content);
          } catch (e) {
            fail("reparent-note", e, nt.id);
            continue;
          }
        }
        report.reparented.notes++;
      }
    } catch (e) {
      fail("fetch-notes", e, dupId);
    }

    // Activities + Attachments — enumerate only; left on the duplicate for the
    // admin (no reliable Zoho v2 move). Surfaced so nothing is silently lost.
    for (const list of ACTIVITY_LISTS) {
      try {
        const acts = await fetchZohoRelatedRecords(module, dupId, list, { perPage: 200 });
        report.leftOnDuplicate.activities += acts.length;
      } catch {
        /* related list may not exist — ignore */
      }
    }
    try {
      const atts = await fetchZohoRelatedRecords(module, dupId, "Attachments", { perPage: 200 });
      report.leftOnDuplicate.attachments += atts.length;
    } catch {
      /* ignore */
    }
  }

  if (report.leftOnDuplicate.activities > 0 || report.leftOnDuplicate.attachments > 0) {
    report.warnings.push(
      `${report.leftOnDuplicate.activities} activity(ies) and ${report.leftOnDuplicate.attachments} attachment(s) remain on the tagged duplicate(s) — Zoho v2 has no reliable move; the admin should review them before deleting.`,
    );
  }

  // 3) Tag the duplicates for the admin to delete. Exclude any ids already
  //    detected as ghosts (deleted in Zoho during the migrate/reparent steps)
  //    — Zoho's add_tags 400s on a deleted record id, which otherwise surfaces
  //    as a spurious "Applied with 1 error" even though there was nothing left
  //    to tag. Those ids are handled as stale_pending instead.
  const liveDups = dups.filter((d) => !ghostIds.has(d));
  if (liveDups.length > 0 && !dryRun) {
    try {
      await addZohoTags(module, liveDups, [plan.tagName]);
      report.taggedRecordIds = [...liveDups];
    } catch (e) {
      // The batch add_tags failed. Zoho's add_tags returns a generic 400 with
      // no per-id detail, so we can't tell deleted-record from a real problem
      // from the message alone. Re-VERIFY each id: ones that are actually gone
      // (fetchZohoRecordById → null on 404/204) are marked stale (a deleted
      // record can't be tagged — that's fine); ones still alive are retried,
      // and only a failure on a LIVE record is reported as a hard error.
      if (isGhostRecordError(e)) {
        for (const d of liveDups) markGhost(d);
      } else {
        const stillAlive: string[] = [];
        for (const d of liveDups) {
          let alive = true;
          try {
            alive = (await fetchZohoRecordById(module, d)) !== null;
          } catch (verifyErr) {
            // Couldn't verify — be conservative and keep it as alive so a
            // genuine tag problem isn't silently swallowed.
            if (isGhostRecordError(verifyErr)) alive = false;
          }
          if (alive) stillAlive.push(d);
          else markGhost(d);
        }
        if (stillAlive.length > 0) {
          // Retry tagging only the records confirmed to still exist — a
          // failure here is a genuine tag problem worth surfacing.
          try {
            await addZohoTags(module, stillAlive, [plan.tagName]);
            report.taggedRecordIds = [...stillAlive];
          } catch (e2) {
            fail("tag-duplicates", e2);
          }
        } else {
          report.warnings.push(
            `Tag step skipped — all ${liveDups.length} duplicate(s) were already deleted in Zoho, so there was nothing to tag.`,
          );
        }
      }
    }
  } else if (liveDups.length > 0) {
    report.taggedRecordIds = [...liveDups]; // dry-run: would tag these
  }

  // 4) Stamp audit notes (survivor + each duplicate).
  if (!dryRun) {
    const stamp = `Absorbed duplicate(s) ${dups.join(", ")} via QMS Agentic Resolution by ${performedBy}${plan.generatedAt ? " on " + plan.generatedAt : ""}.`;
    try {
      await addZohoNote(module, masterId, "QMS Agentic Resolution — survivor", stamp);
      report.notesStamped++;
    } catch (e) {
      fail("stamp-master", e, masterId);
    }
    for (const dupId of dups) {
      if (ghostIds.has(dupId)) continue;
      try {
        await addZohoNote(
          module,
          dupId,
          "Marked for deletion — QMS Duplicate Radar",
          `Merged into ${masterId} (${plan.masterName}) by ${performedBy}. Tagged "${plan.tagName}" — safe for the Zoho admin to delete.`,
        );
        report.notesStamped++;
      } catch (e) {
        fail("stamp-duplicate", e, dupId);
      }
    }
  } else {
    report.notesStamped = 1 + dups.length; // dry-run: would stamp survivor + each dup
  }

  // 5) Mark the survivor primary + resolve the cluster internally — but ONLY
  // when this run is allowed to close it. For cross-module clusters
  // closeCluster is false, so the cluster stays active for the remaining
  // modules' Agentic Resolution sections; Agentic only handles Accounts here.
  const closeCluster = opts.closeCluster !== false;
  if (!dryRun && closeCluster) {
    try {
      if (typeof plan.masterDbId === "number") {
        await markPrimaryRecord(plan.clusterId, plan.masterDbId);
      }
      await resolveCluster(
        plan.clusterId,
        "resolve",
        performedBy,
        typeof plan.masterDbId === "number" ? plan.masterDbId : undefined,
        `Agentic merge: fields migrated onto ${masterId}; ${dups.length} duplicate(s) tagged ${plan.tagName}.`,
      );
      report.clusterResolved = true;
    } catch (e) {
      fail("resolve-cluster", e);
    }
  } else if (!dryRun && !closeCluster) {
    report.warnings.push(
      "Cross-module cluster: duplicate Accounts were migrated & tagged, but the cluster was left OPEN. Finish the other modules (Leads / Deals / Contacts) via their own Agentic Resolution sections — the cluster auto-resolves once the next sync sees every module's duplicates merged or tagged in Zoho.",
    );
    // Record the partial merge so subsequent same-cluster plans for the
    // OTHER modules can filter out the just-tagged duplicates (else the
    // LINK SURVIVOR TO ACCOUNT picker keeps showing zombie SLB / Slb
    // buttons next to the real Schlumberger (SLB) survivor). Best-effort;
    // a logging failure must not abort the Zoho writes already done.
    try {
      const dupDbIds = (plan.duplicateDbIds || []).filter(
        (n): n is number => typeof n === "number",
      );
      await recordPartialMergeAction(
        plan.clusterId,
        typeof plan.masterDbId === "number" ? plan.masterDbId : null,
        dupDbIds,
        performedBy,
        `Module merge (${module}): survivor=${masterId}; ${dups.length} duplicate(s) tagged ${plan.tagName}. Cluster left open for cross-module follow-up.`,
      );
    } catch (e) {
      fail("record-partial-merge", e);
    }
  }

  // Durable solved-ledger write — keyed by stable Zoho identity so the per-
  // module "solved" scoreboard survives a Rebuild Clusters wipe. Only on a
  // clean real run (no errors): a partial/failed apply must not be credited as
  // solved. closeCluster=false ⇒ a single module was merged (the rest of a
  // cross-module cluster stays open) ⇒ record it as 'module_resolved'. Best-
  // effort; covers both the autonomous auto-apply and the manual Apply button.
  if (!dryRun && report.errors.length === 0) {
    await recordResolutionLedgerEntry({
      module,
      masterZohoId: masterId,
      duplicateZohoIds: dups,
      actionType: closeCluster ? "resolve" : "module_resolved",
      performedBy,
      notes: `Agentic ${closeCluster ? "merge" : "module merge"} into ${masterId}`,
    }).catch(() => {});
  }

  if (report.staleDropped.length > 0) {
    const idsPreview = report.staleDropped.slice(0, 5).join(", ");
    const more =
      report.staleDropped.length > 5
        ? ` (+${report.staleDropped.length - 5} more)`
        : "";
    report.warnings.push(
      `${report.staleDropped.length} duplicate record(s) auto-cleaned — already deleted in Zoho (${idsPreview}${more}). Tagged stale_pending locally; the next sync will purge them. ${dryRun ? "" : "No further apply attempts will be made against these ids."}`.trim(),
    );
  }

  logger.info(
    `[merge-executor] ${dryRun ? "DRY-RUN" : "APPLIED"} cluster ${plan.clusterId}: ` +
      `${report.fieldsMigrated.length} field(s), reparented ${report.reparented.deals}D/${report.reparented.contacts}C/${report.reparented.notes}N, ` +
      `tagged ${report.taggedRecordIds.length}, errors ${report.errors.length}, stale-dropped ${report.staleDropped.length}`,
  );

  return report;
}
