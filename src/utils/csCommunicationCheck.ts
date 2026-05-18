/**
 * Communication-eligibility check — answers "can SDR/Marketing contact
 * this domain right now, or is it an active customer?"
 *
 * Combines three signals:
 *   1. Contract state    (signed?  paid?)               via csContractState
 *   2. CS lifecycle      (Phase + Churn Date)            via duplicateRadarCsOverlap
 *   3. Sector cool-off   (private 6mo / government 12mo) via duplicateRadarCsOverlap
 *
 * Verdict matrix:
 *
 *   ever_a_customer = YES (signed or paid)
 *   ──────────────────────────────────────────────────────────────────────
 *   no churn date                            →  BLOCK   active customer
 *   churn date < sector cool-off             →  BLOCK   in CS recovery
 *   churn date >= sector cool-off            →  ALLOW   past cool-off
 *
 *   ever_a_customer = NO (prospect that never closed)
 *   ──────────────────────────────────────────────────────────────────────
 *   in active CS phase (Onboarding/Adoption/ →  REVIEW  deal in progress
 *     Renewal)                                            with no contract
 *   phase = Termination, or no phase / lost  →  ALLOW   never a customer
 *
 * The query side: given a `domain`, finds every Deal record indexed by the
 * radar that matches it (via raw_data.Company_Domain OR cluster.domain OR
 * duplicate_records.domain), evaluates each Deal, then rolls up to a
 * single verdict using strongest-wins.
 */

import { pool } from "./duplicateRadarDatabase";
import {
  assessContractState,
  type CsContractAssessment,
} from "./csContractState";
import {
  classifyCsOverlap,
  extractCsFieldsFromRawData,
} from "./duplicateRadarCsOverlap";

export type CommunicationVerdict = "block" | "review" | "allow";

export interface CommunicationCheckMatchedDeal {
  duplicate_record_id: number;
  zoho_record_id: string | null;
  account_name: string | null;
  domain: string | null;
  company_domain: string | null;
  cluster_id: number | null;
  phase: string | null;
  stage_value: string | null;
  is_signed: boolean;
  is_paid: boolean;
  ever_a_customer: boolean;
  signed_signals: string[];
  paid_signals: string[];
  churn_date: string | null;
  churn_days: number | null;
  sector: "private" | "government" | null;
  per_deal_verdict: CommunicationVerdict;
  per_deal_reason: string;
}

export interface CommunicationCheckResponse {
  domain_query: string;
  examined_deals: number;
  verdict: CommunicationVerdict;
  reason: string;
  suggested_action: string;
  /** Strongest signal across matched deals. */
  ever_a_customer: boolean;
  active_now: boolean;
  matched_deals: CommunicationCheckMatchedDeal[];
}

function normalizeQuery(d: string): string {
  return d
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]!
    .trim();
}

const VERDICT_RANK: Record<CommunicationVerdict, number> = {
  block: 3,
  review: 2,
  allow: 1,
};

function strongest(a: CommunicationVerdict, b: CommunicationVerdict): CommunicationVerdict {
  return VERDICT_RANK[a] >= VERDICT_RANK[b] ? a : b;
}

function perDealVerdict(input: {
  contract: CsContractAssessment;
  phase: string | null;
  churnDays: number | null;
  cooloffDays: number;
  activePhases: string[];
  terminationPhase: string;
}): { verdict: CommunicationVerdict; reason: string } {
  const { contract, phase, churnDays, cooloffDays, activePhases, terminationPhase } = input;
  const phaseLc = (phase || "").toLowerCase();
  const isActive = activePhases.some((p) => p.toLowerCase() === phaseLc);
  const isTermination = phaseLc === terminationPhase.toLowerCase();

  if (contract.ever_a_customer) {
    if (churnDays == null) {
      return {
        verdict: "block",
        reason: "active_signed_customer_no_churn",
      };
    }
    if (churnDays < cooloffDays) {
      return {
        verdict: "block",
        reason: `signed_customer_within_cooloff:${churnDays}d<${cooloffDays}d`,
      };
    }
    return {
      verdict: "allow",
      reason: `signed_customer_past_cooloff:${churnDays}d>=${cooloffDays}d`,
    };
  }

  // Never a customer (no signed/paid signal)
  if (isActive) {
    return {
      verdict: "review",
      reason: `prospect_in_active_phase:${phase}`,
    };
  }
  if (isTermination) {
    return {
      verdict: "allow",
      reason: "prospect_terminated_never_signed",
    };
  }
  // No phase or unknown phase, no contract → free to communicate
  return {
    verdict: "allow",
    reason: phase ? `prospect_phase:${phase}_no_contract` : "no_cs_record",
  };
}

function suggestedAction(verdict: CommunicationVerdict, reason: string): string {
  if (verdict === "block") {
    if (reason.startsWith("active_signed")) {
      return "Do NOT contact. This is an active signed customer — route to CS owner.";
    }
    if (reason.startsWith("signed_customer_within_cooloff")) {
      return "Do NOT contact. Customer churned recently; CS may be in recovery. Coordinate with CS before any outreach.";
    }
    return "Do NOT contact. See per-deal reason for details.";
  }
  if (verdict === "review") {
    return "Hold and review. Prospect deal in progress without a signed contract — confirm with the deal owner before any parallel outreach.";
  }
  return "OK to communicate. No active contract conflict.";
}

/**
 * Evaluate communication eligibility for a domain.
 *
 * Looks up every Deal record indexed by the radar whose domain matches,
 * evaluates each, rolls up to a single verdict (strongest wins), and
 * returns per-deal detail so the caller can show their reasoning.
 */
export async function checkCommunicationEligibility(input: {
  domain: string;
}): Promise<CommunicationCheckResponse> {
  const domainQuery = normalizeQuery(input.domain || "");
  if (!domainQuery) {
    return {
      domain_query: "",
      examined_deals: 0,
      verdict: "allow",
      reason: "empty_domain",
      suggested_action: "No domain provided — defaulting to allow. Re-check with a valid domain.",
      ever_a_customer: false,
      active_now: false,
      matched_deals: [],
    };
  }

  // Match deals where:
  //   - The radar's stored record-level domain matches
  //   - OR the parent cluster's domain matches
  //   - OR the Deal's raw_data exposes a matching Company_Domain
  // The first two are cheap indexed lookups; the third uses a JSONB op.
  const dealsR = await pool.query<{
    id: number;
    zoho_record_id: string | null;
    account_name: string | null;
    record_domain: string | null;
    cluster_id: number | null;
    cluster_domain: string | null;
    raw_data: unknown;
    modified_date: Date | string | null;
    gov_type: string | null;
  }>(
    `SELECT r.id,
            r.zoho_record_id,
            r.account_name,
            r.domain AS record_domain,
            r.cluster_id,
            c.domain AS cluster_domain,
            r.raw_data,
            r.modified_date,
            r.gov_type
       FROM duplicate_records r
       LEFT JOIN duplicate_clusters c ON c.id = r.cluster_id
      WHERE r.zoho_module = 'Deals'
        AND (
              LOWER(r.domain) = $1
           OR LOWER(c.domain) = $1
           OR LOWER(COALESCE(r.raw_data->>'Company_Domain','')) = $1
           OR LOWER(COALESCE(r.raw_data->>'company_domain','')) = $1
        )
      LIMIT 50`,
    [domainQuery],
  );

  if (dealsR.rows.length === 0) {
    return {
      domain_query: domainQuery,
      examined_deals: 0,
      verdict: "allow",
      reason: "no_matching_deal_found",
      suggested_action: "OK to communicate. No matching Deal in CRM for this domain.",
      ever_a_customer: false,
      active_now: false,
      matched_deals: [],
    };
  }

  const matched: CommunicationCheckMatchedDeal[] = [];
  let rolledVerdict: CommunicationVerdict = "allow";
  let rolledReason = "no_matching_deal_found";
  let everCustomer = false;
  let activeNow = false;

  for (const row of dealsR.rows) {
    const contract = assessContractState(row.raw_data);
    const fields = extractCsFieldsFromRawData(row.raw_data, {
      domain: row.record_domain || row.cluster_domain || null,
    });
    if (row.gov_type) fields.gov_type = row.gov_type;

    // Reuse the existing CS overlap classifier to compute sector + churn days
    const cls = classifyCsOverlap(fields);

    // Resolve cool-off days per sector (matching CS overlap config defaults)
    const sectorCooloff =
      cls.sector === "government"
        ? Number.parseInt(
            process.env.DUPLICATE_RADAR_CHURN_COOLOFF_GOVERNMENT_DAYS ?? "365",
            10,
          )
        : Number.parseInt(
            process.env.DUPLICATE_RADAR_CHURN_COOLOFF_PRIVATE_DAYS ?? "180",
            10,
          );

    const activePhases = (
      process.env.DUPLICATE_RADAR_CS_ACTIVE_PHASES ||
      "Onboarding,Adoption,Renewal"
    )
      .split(",")
      .map((s) => s.trim());
    const terminationPhase =
      process.env.DUPLICATE_RADAR_CS_TERMINATION_PHASE?.trim() || "Termination";

    const pd = perDealVerdict({
      contract,
      phase: fields.phase ?? null,
      churnDays: cls.churn_days,
      cooloffDays: sectorCooloff,
      activePhases,
      terminationPhase,
    });

    const churnDate =
      fields.churn_date instanceof Date
        ? fields.churn_date.toISOString().slice(0, 10)
        : fields.churn_date
          ? String(fields.churn_date)
          : null;

    matched.push({
      duplicate_record_id: row.id,
      zoho_record_id: row.zoho_record_id ?? null,
      account_name: row.account_name ?? null,
      domain: row.record_domain ?? null,
      company_domain: fields.company_domain ?? null,
      cluster_id: row.cluster_id ?? null,
      phase: fields.phase ?? null,
      stage_value: contract.stage_value,
      is_signed: contract.is_signed,
      is_paid: contract.is_paid,
      ever_a_customer: contract.ever_a_customer,
      signed_signals: contract.signed_signals,
      paid_signals: contract.paid_signals,
      churn_date: churnDate,
      churn_days: cls.churn_days,
      sector: cls.sector,
      per_deal_verdict: pd.verdict,
      per_deal_reason: pd.reason,
    });

    if (contract.ever_a_customer) everCustomer = true;
    if (
      contract.ever_a_customer &&
      (cls.churn_days == null || cls.churn_days < sectorCooloff)
    ) {
      activeNow = true;
    }

    if (VERDICT_RANK[pd.verdict] >= VERDICT_RANK[rolledVerdict]) {
      rolledVerdict = strongest(rolledVerdict, pd.verdict);
      rolledReason = pd.reason;
    }
  }

  return {
    domain_query: domainQuery,
    examined_deals: matched.length,
    verdict: rolledVerdict,
    reason: rolledReason,
    suggested_action: suggestedAction(rolledVerdict, rolledReason),
    ever_a_customer: everCustomer,
    active_now: activeNow,
    matched_deals: matched,
  };
}

// Exported for tests
export { perDealVerdict, normalizeQuery };
