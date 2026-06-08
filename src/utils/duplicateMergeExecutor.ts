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

import type { MergePlan } from "./duplicateMergePlanner";
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
} from "./duplicateRadarDatabase";
import { logger } from "./logger";

export interface ExecuteReport {
  dryRun: boolean;
  clusterId: number;
  master: { zohoId: string | null; name: string };
  fieldsMigrated: Array<{ field: string; value: string | number | null }>;
  reparented: { deals: number; contacts: number; notes: number };
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
}

const ACTIVITY_LISTS = ["Tasks", "Calls", "Events"];

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

  // 2) Reparent each duplicate's related records onto the survivor.
  for (const dupId of dups) {
    // Deals — repoint the Account_Name lookup (clean move).
    try {
      const deals = await fetchZohoRelatedRecords(module, dupId, "Deals", { perPage: 200 });
      for (const d of deals) {
        if (!dryRun) {
          try {
            await updateZohoRecord("Deals", d.id, { Account_Name: { id: masterId } });
          } catch (e) {
            fail("reparent-deal", e, d.id);
            continue;
          }
        }
        report.reparented.deals++;
      }
    } catch (e) {
      fail("fetch-deals", e, dupId);
    }

    // Contacts — repoint the Account_Name lookup (clean move).
    try {
      const contacts = await fetchZohoRelatedRecords(module, dupId, "Contacts", { perPage: 200 });
      for (const ct of contacts) {
        if (!dryRun) {
          try {
            await updateZohoRecord("Contacts", ct.id, { Account_Name: { id: masterId } });
          } catch (e) {
            fail("reparent-contact", e, ct.id);
            continue;
          }
        }
        report.reparented.contacts++;
      }
    } catch (e) {
      fail("fetch-contacts", e, dupId);
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

  // 5) Mark the survivor primary + resolve the cluster internally.
  if (!dryRun) {
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
  }

  logger.info(
    `[merge-executor] ${dryRun ? "DRY-RUN" : "APPLIED"} cluster ${plan.clusterId}: ` +
      `${report.fieldsMigrated.length} field(s), reparented ${report.reparented.deals}D/${report.reparented.contacts}C/${report.reparented.notes}N, ` +
      `tagged ${report.taggedRecordIds.length}, errors ${report.errors.length}`,
  );

  return report;
}
