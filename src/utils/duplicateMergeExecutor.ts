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
  addZohoTags,
  addZohoNote,
} from "./zohoCRM";
import {
  captureClusterSnapshot,
  resolveCluster,
  markPrimaryRecord,
  recordPartialMergeAction,
} from "./duplicateRadarDatabase";
import { logger } from "./logger";

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
}

export interface ExecuteOptions {
  performedBy: string;
  /** Default true — must be explicitly set false (operator confirm) to write. */
  dryRun?: boolean;
  /**
   * Whether to mark the whole cluster resolved after the Account writes.
   * Default true. Set FALSE for cross-module clusters — Agentic Resolution
   * touches Accounts only, so closing the cluster would skip the cross-module
   * link/close step the manual "Mark Resolved" flow performs and drop the
   * cluster from the active list prematurely. Leaving it open preserves that
   * follow-up.
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
  };

  const fail = (step: string, e: unknown, recordId?: string) => {
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
  // duplicate in the cluster (Contacts / Deals only). Tagging a contact for
  // deletion does not erase it from Zoho; the admin reviews each tagged
  // record before flipping the delete switch and needs to see the right
  // parent Account on every row, not just the one that survives. Failures
  // on a duplicate are tracked but do not abort — the survivor link is the
  // load-bearing write.
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
        try {
          await updateZohoRecord(module, dupId, {
            Account_Name: { id: plan.linkAccountZohoId },
          });
        } catch (e) {
          fail("link-account-duplicate", e, dupId);
        }
      }
    }
  }

  // 2) Reparent each duplicate's related records onto the survivor.
  for (const dupId of dups) {
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

  // 3) Tag the duplicates for the admin to delete.
  if (dups.length > 0 && !dryRun) {
    try {
      await addZohoTags(module, dups, [plan.tagName]);
      report.taggedRecordIds = [...dups];
    } catch (e) {
      fail("tag-duplicates", e);
    }
  } else if (dups.length > 0) {
    report.taggedRecordIds = [...dups]; // dry-run: would tag these
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
  // closeCluster is false, so the cluster stays active for the cross-module
  // link/close step (manual "Mark Resolved"); Agentic only handles Accounts.
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
      "Cross-module cluster: duplicate Accounts were migrated & tagged, but the cluster was left OPEN — link/close the Leads/Deals/Contacts via Mark Resolved to finish it.",
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

  logger.info(
    `[merge-executor] ${dryRun ? "DRY-RUN" : "APPLIED"} cluster ${plan.clusterId}: ` +
      `${report.fieldsMigrated.length} field(s), reparented ${report.reparented.deals}D/${report.reparented.contacts}C/${report.reparented.notes}N, ` +
      `tagged ${report.taggedRecordIds.length}, errors ${report.errors.length}`,
  );

  return report;
}
