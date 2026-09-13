/**
 * Weekly Sales/SDR reports for the wp-sdr-sales-audits channel.
 *
 * Sarah 2026-09-07: the Sales channel should carry the weekly audit, plus a
 * deal-compliance report and an active-deal-conflicts report, "for product
 * walaplus, corporates" — and earlier, "weekly with the audits, and only when
 * there are conflicts".
 *
 * Both datasets already existed and neither had ever notified anyone:
 * runDealDocComplianceSweep writes compliance results to the database with no
 * announcement of any kind, and Active Deal Conflicts existed only as a sheet
 * title inside an Excel export. They produced numbers nobody was shown.
 *
 * THRESHOLD-GATED, deliberately. Each returns without posting when there is
 * nothing wrong. A weekly "all clear" trains people to skim the channel, and
 * then the week that is not clear gets skimmed too.
 *
 * SEGMENT: walaplus/corporate only. Marketplace deals are a different team's
 * problem and would make the Sales numbers wrong.
 */

import { logger } from "./logger";

/** The segment these reports cover. Corporate == "walaplus" in radar terms. */
const SEGMENT = "walaplus";

/**
 * Stages left out of the Sales compliance report (Sarah 2026-09-07: "don't
 * include the PAID stage here inside the channel").
 *
 * Paid is closed business. The first real report showed 386 missing documents
 * out of 387 Paid deals — historic records the SDR/Sales team cannot act on,
 * and at that volume they crowd out the stages that are still open and still
 * fixable. Excluded from the TOTALS as well as the breakdown, so the headline
 * figure matches what is listed underneath.
 *
 * Override with SALES_COMPLIANCE_EXCLUDE_STAGES (comma-separated) if the stage
 * names change in Zoho.
 */
const EXCLUDED_STAGES = (
  process.env.SALES_COMPLIANCE_EXCLUDE_STAGES || "Paid"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Deals whose required documents are missing, weekly. */
export async function runDealComplianceWeeklyReport(): Promise<{
  posted: boolean;
  checked: number;
  missing: number;
}> {
  const { getSegmentDealComplianceSummary } = await import(
    "./duplicateRadarDatabase"
  );
  const summary = await getSegmentDealComplianceSummary(SEGMENT as any, {
    excludeStages: EXCLUDED_STAGES,
  });

  const missing = summary.checked - summary.compliant;
  if (summary.checked === 0 || missing === 0) {
    logger.info(
      `[SalesDaily] Deal compliance: ${summary.checked} checked, none missing docs — not posting`,
    );
    return { posted: false, checked: summary.checked, missing: 0 };
  }

  // compliant_rate is ALREADY a percentage — shapeDealCompliance returns
  // Math.round(100 * compliant / checked). Multiplying again printed
  // "compliant 1800.0%" in the first real report, on a figure that was
  // actually 18%. A wrong number in a compliance report is worse than no
  // report, so this is used verbatim.
  const rate =
    summary.compliant_rate !== null ? `${summary.compliant_rate}%` : "n/a";
  const atRisk = Number(summary.at_risk_sar) || 0;

  const lines: string[] = [
    `*${missing}* deal(s) missing required documents out of ${summary.checked} checked · compliant ${rate}`,
  ];
  // State the exclusion. A scoped total read as a full total is how a report
  // quietly misleads — the reader has no way to tell otherwise.
  if (EXCLUDED_STAGES.length > 0) {
    lines.push(`_Excludes ${EXCLUDED_STAGES.join(", ")} — closed business._`);
  }
  if (atRisk > 0) {
    lines.push(`Value on non-compliant deals: SAR ${atRisk.toLocaleString()}`);
  }
  if (summary.by_stage.length > 0) {
    lines.push(
      "\n*By stage:*\n" +
        summary.by_stage
          .filter((s) => s.missing > 0)
          .slice(0, 8)
          .map((s) => `• ${s.stage}: ${s.missing} missing of ${s.checked}`)
          .join("\n"),
    );
  }
  if (summary.by_owner.length > 0) {
    const owners = summary.by_owner.filter((o) => o.missing > 0).slice(0, 8);
    if (owners.length > 0) {
      lines.push(
        "\n*By owner:*\n" +
          owners.map((o) => `• ${o.owner}: ${o.missing} missing`).join("\n") +
          (summary.owner_overflow > 0
            ? `\n• …and ${summary.owner_overflow} more owner(s)`
            : ""),
      );
    }
  }
  if (summary.top_missing_docs.length > 0) {
    lines.push(
      "\n*Most-missed documents:*\n" +
        summary.top_missing_docs
          .slice(0, 6)
          .map((d) => `• ${d.label}: ${d.count}`)
          .join("\n"),
    );
  }

  await announceToSales({
    type: "deal_compliance_weekly",
    title: `📄 Deal compliance — ${missing} deal(s) missing documents`,
    message: lines.join("\n"),
    actionUrl: "/duplicates",
    entityType: "deal_compliance",
  });

  logger.info(
    `[SalesDaily] Deal compliance posted: ${missing}/${summary.checked} missing`,
  );
  return { posted: true, checked: summary.checked, missing };
}

/** Accounts carrying more than one open deal, weekly. */
export async function runActiveDealConflictsWeeklyReport(): Promise<{
  posted: boolean;
  accounts: number;
  multiOwner: number;
}> {
  // Same list as the tab, split-account conflicts included (Sarah 2026-09-13).
  // The 08:00 post on the 13th said "2 account(s)" while fourteen more
  // companies had two sellers on them — each with its deals on two Account
  // records, so no single account looked like a conflict. The channel is where
  // Sales actually reads this, so it must count what the tab counts.
  const { getActiveDealConflictsIncludingSplits } = await import(
    "./splitAccountDealConflicts"
  );
  const rows = await getActiveDealConflictsIncludingSplits(SEGMENT as any, {
    limit: 2000,
    bypassCache: true,
  });

  if (!rows || rows.length === 0) {
    logger.info("[SalesDaily] Active deal conflicts: none — not posting");
    return { posted: false, accounts: 0, multiOwner: 0 };
  }

  // Two different owners chasing the same company is the case that actually
  // costs the team, so it leads the message and is counted separately.
  const multiOwner = rows.filter((r) => r.distinct_owners > 1);
  const totalOpen = rows.reduce((s, r) => s + (Number(r.open_deals) || 0), 0);
  const totalValue = rows.reduce(
    (s, r) => s + (Number(r.total_open_value) || 0),
    0,
  );

  const lines: string[] = [
    `*${rows.length}* compan${rows.length === 1 ? "y" : "ies"} with more than one OPEN deal · ${totalOpen} open deals total` +
      (rows.some((r) => r.split_account)
        ? ` · ${rows.filter((r) => r.split_account).length} of them split across Account records`
        : "") +
      (totalValue > 0 ? ` · SAR ${Math.round(totalValue).toLocaleString()}` : ""),
  ];
  if (multiOwner.length > 0) {
    lines.push(
      `\n*${multiOwner.length} of those have deals across DIFFERENT owners:*\n` +
        multiOwner
          .slice(0, 10)
          .map(
            (r) =>
              `• ${r.account_name} — ${r.open_deals} deals, ${r.distinct_owners} owners (${(r.owners || []).slice(0, 3).join(", ")})` +
              (r.split_account
                ? ` — _split across ${(r.split_accounts || []).length} Account records, merge them first_`
                : ""),
          )
          .join("\n") +
        (multiOwner.length > 10
          ? `\n• …and ${multiOwner.length - 10} more`
          : ""),
    );
  }

  const singleOwner = rows.length - multiOwner.length;
  if (singleOwner > 0) {
    lines.push(
      `\n${singleOwner} account(s) have multiple open deals under a single owner — usually legitimate, worth a glance.`,
    );
  }

  await announceToSales({
    type: "active_deal_conflicts_weekly",
    title: `⚔️ Active deal conflicts — ${rows.length} compan${rows.length === 1 ? "y" : "ies"}, ${multiOwner.length} across different owners`,
    message: lines.join("\n"),
    actionUrl: "/duplicates",
    entityType: "active_deal_conflicts",
  });

  logger.info(
    `[SalesDaily] Active deal conflicts posted: ${rows.length} accounts, ${multiOwner.length} multi-owner`,
  );
  return { posted: true, accounts: rows.length, multiOwner: multiOwner.length };
}

/**
 * Send to the SALES/SDR channel.
 *
 * module "Deals" is what routes it — slackChannelRouting maps Deals to the
 * sales_sdr audience. Priority "high" because notifyEvent only extends beyond
 * in-app at critical|high, and in-app has no reachable reader; anything lower
 * would be written and never seen.
 */
async function announceToSales(event: {
  type: string;
  title: string;
  message: string;
  actionUrl: string;
  entityType: string;
}): Promise<void> {
  try {
    const { notifyEvent } = await import("./notificationHub");
    await notifyEvent({
      type: event.type,
      module: "Deals",
      title: event.title,
      message: event.message,
      priority: "high",
      entityType: event.entityType,
      actionUrl: event.actionUrl,
    });
  } catch (err) {
    logger.error("[SalesDaily] Announcement failed:", err);
  }
}
