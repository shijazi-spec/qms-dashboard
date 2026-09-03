/**
 * Detect whether a Deal record represents a customer that ever actually
 * signed/paid — not just a prospect that worked its way through the
 * pipeline without ever closing.
 *
 * This is the additional gate the Duplicate Radar uses (alongside Phase +
 * Churn Date) to decide whether an incoming contact should be allowed to
 * be communicated with:
 *
 *   - signed AND not churned (or churn within sector cool-off)  →  BLOCK
 *   - signed AND churn past sector cool-off                      →  ALLOW
 *   - NOT signed AND still in active phase                       →  REVIEW
 *   - NOT signed AND closed/lost                                 →  ALLOW (was never a customer)
 *
 * Signal detection is env-configurable so Quality / Ops can adjust without
 * a redeploy. Defaults reflect what we observed in ExampleOrg Zoho:
 *
 *   STAGE = "Agreement Signed"  →  signed
 *   Invoiced = "Yes"             →  paid
 *
 * Pure functions only. No DB or network calls; safe to use anywhere.
 */

export interface CsContractAssessment {
  is_signed: boolean;
  is_paid: boolean;
  /** Either signed OR paid — was this a real customer at any point? */
  ever_a_customer: boolean;
  /** Which signals fired (for audit trail + UI). */
  signed_signals: string[];
  paid_signals: string[];
  /** The raw `Stage` value (if found) so the caller can display it. */
  stage_value: string | null;
}

interface Config {
  signedStages: string[];
  signedFields: string[];
  signedFieldTruthy: string[];
  paidFields: string[];
  paidFieldTruthy: string[];
  stageFieldKeys: string[];
}

let cachedConfig: Config | null = null;

function loadConfig(): Config {
  if (cachedConfig) return cachedConfig;
  const list = (v: string | undefined, fallback: string[]): string[] =>
    (v ?? "").trim()
      ? (v as string).split(",").map((s) => s.trim()).filter(Boolean)
      : fallback;

  cachedConfig = {
    // Deal `Stage` values that mean the customer signed.
    signedStages: list(process.env.CS_SIGNED_STAGES, [
      "Agreement Signed",
      "Closed Won",
      "Won",
      "Signed",
    ]),
    // Boolean / status fields that, when truthy, also mean signed.
    signedFields: list(process.env.CS_SIGNED_FIELDS, [
      "Agreement_Signed",
      "Contract_Signed",
      "Contract_Status",
    ]),
    signedFieldTruthy: list(process.env.CS_SIGNED_FIELD_TRUTHY, [
      "yes",
      "true",
      "1",
      "active",
      "signed",
    ]),
    // Boolean / status fields that mean paid (Invoiced=Yes in our case).
    paidFields: list(process.env.CS_PAID_FIELDS, [
      "Invoiced",
      "Payment_Status",
      "Paid",
    ]),
    paidFieldTruthy: list(process.env.CS_PAID_FIELD_TRUTHY, [
      "yes",
      "true",
      "1",
      "paid",
      "active",
    ]),
    // Keys to try when reading the Deal's stage value out of raw_data.
    stageFieldKeys: list(process.env.CS_STAGE_FIELD_KEYS, [
      "Stage",
      "stage",
      "Deal_Stage",
    ]),
  };
  return cachedConfig;
}

/** Test helper — reset config cache between cases. */
export function resetCsContractStateConfigCache(): void {
  cachedConfig = null;
}

function readField(raw: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (raw[k] !== undefined && raw[k] !== null && raw[k] !== "") return raw[k];
  }
  return null;
}

function asString(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

/**
 * Evaluate the contract state of a Deal record's raw_data.
 *
 * @param rawData The JSON blob the radar stores on duplicate_records.raw_data.
 */
export function assessContractState(rawData: unknown): CsContractAssessment {
  const cfg = loadConfig();
  if (!rawData || typeof rawData !== "object") {
    return {
      is_signed: false,
      is_paid: false,
      ever_a_customer: false,
      signed_signals: [],
      paid_signals: [],
      stage_value: null,
    };
  }
  const raw = rawData as Record<string, unknown>;

  const stageVal = asString(readField(raw, cfg.stageFieldKeys));
  const signedSignals: string[] = [];
  const paidSignals: string[] = [];

  // Signal 1: Stage value matches a configured signed-stage.
  if (
    stageVal &&
    cfg.signedStages.some((s) => s.toLowerCase() === stageVal.toLowerCase())
  ) {
    signedSignals.push(`stage:${stageVal}`);
  }

  // Signal 2: Any of the configured signed-fields holds a truthy value.
  for (const f of cfg.signedFields) {
    const v = asString(raw[f]).toLowerCase();
    if (v && cfg.signedFieldTruthy.some((t) => t.toLowerCase() === v)) {
      signedSignals.push(`field:${f}=${raw[f]}`);
    }
  }

  // Signal 3: Paid — Invoiced = Yes (or any configured paid-field truthy).
  for (const f of cfg.paidFields) {
    const v = asString(raw[f]).toLowerCase();
    if (v && cfg.paidFieldTruthy.some((t) => t.toLowerCase() === v)) {
      paidSignals.push(`field:${f}=${raw[f]}`);
    }
  }

  const is_signed = signedSignals.length > 0;
  const is_paid = paidSignals.length > 0;
  return {
    is_signed,
    is_paid,
    ever_a_customer: is_signed || is_paid,
    signed_signals: signedSignals,
    paid_signals: paidSignals,
    stage_value: stageVal || null,
  };
}
