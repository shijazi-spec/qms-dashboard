/**
 * Certification Action Plan — pure evidence resolver.
 *
 * Turns a query result (counts) into an honest verdict about whether an
 * action's evidence source proves the action is done. Deliberately has
 * ZERO imports — no pool/db module, no `Date.now()`, no `new Date()`. Any
 * "today" a caller needs must be passed in as a parameter by the (thin,
 * impure) route layer that calls this module.
 *
 * The whole point of this module is to never collapse "not done" and
 * "we cannot tell" into the same signal. See
 * docs/superpowers/specs/2026-09-03-certification-action-plan-design.md §3 / §4.2.
 */

/**
 * - "satisfied"     — the evidence proves the action is done.
 * - "not_satisfied" — the evidence was readable and non-empty, but falls short.
 * - "awaiting_data" — the source table/query exists but currently holds no
 *                     rows: the owning module simply has not been used yet.
 *                     A truthful "not yet", never rendered as 0% or satisfied.
 * - "unavailable"   — the source could not be read at all (e.g. a stale
 *                     collector). "We cannot tell" — never reported as
 *                     not_satisfied.
 */
export type EvidenceState = "satisfied" | "not_satisfied" | "awaiting_data" | "unavailable";

export interface EvidenceReading {
  source: string;
  state: EvidenceState;
  have: number;
  need: number;
  detail?: string;
}

/**
 * Resolve one action's evidence counts into a verdict.
 *
 * `counts.total` is accepted (and typically equals `need` for the caller's
 * query shape) but is not itself consulted here — `sourceEmpty` is the
 * signal for "the owning module has not been used yet", decided by the
 * (impure) caller from the same query that produced `have`/`total`.
 *
 * Precedence — evaluated in this exact order because each earlier case is
 * a strictly stronger statement than the ones after it:
 *   1. sourceReadable === false -> unavailable (outranks everything else;
 *      "cannot tell" must never be reported as "not done")
 *   2. sourceEmpty === true     -> awaiting_data (must never render as 0%
 *      or satisfied, even if have/need arithmetic would otherwise pass)
 *   3. need > 0 && have >= need -> satisfied
 *   4. otherwise                -> not_satisfied
 */
export function resolveEvidence(
  source: string,
  counts: { have: number; total: number; sourceEmpty: boolean; sourceReadable: boolean },
): EvidenceReading {
  const have = Number.isFinite(counts.have) ? counts.have : 0;
  const need = Number.isFinite(counts.total) ? counts.total : 0;

  if (counts.sourceReadable === false) {
    return {
      source,
      state: "unavailable",
      have,
      need,
      detail: "Evidence source could not be read",
    };
  }

  if (counts.sourceEmpty === true) {
    return {
      source,
      state: "awaiting_data",
      have,
      need,
      detail: "Evidence source has no rows yet",
    };
  }

  // Guard the arithmetic: need === 0 must never be reported as satisfied
  // (there is nothing to divide by, and "0 of 0" is not proof of anything).
  const state: EvidenceState = need > 0 && have >= need ? "satisfied" : "not_satisfied";

  return { source, state, have, need };
}

/**
 * One action as tracked on the plan. Deliberately minimal — this module
 * only needs enough to decide "is this action done":
 *   - action_key:        stable identifier, used as the lookup key into
 *                         `readings` (mirrors the DB column of the same name).
 *   - verification_mode: "auto" actions are proved by a reading; "manual"
 *                         actions are proved by a person ticking them.
 *   - done_at:            manual-tick timestamp (ISO string) or null.
 *                         Never inspected for auto actions — auto evidence
 *                         is computed live at read time and never stored
 *                         (design §4.2), so done_at is meaningless there.
 */
export interface CertificationActionRef {
  action_key: string;
  verification_mode: "auto" | "manual";
  done_at: string | null;
}

/**
 * Roll up an action list against their resolved evidence readings.
 *
 * - A manual action counts as done only when `done_at` is set (non-null,
 *   non-empty).
 * - An auto action counts as done only when its reading's state is
 *   "satisfied" — "awaiting_data" and "unavailable" do NOT count as done,
 *   even though they are not "not_satisfied" either.
 * - `complete` is true only when every action in the list is done.
 *
 * `readings` is keyed by `action_key`; an auto action with no matching
 * reading is treated as not done (never crashes, never counts as done).
 */
export function milestoneProgress(
  actions: CertificationActionRef[],
  readings: Record<string, EvidenceReading>,
): { done: number; total: number; complete: boolean } {
  const total = actions.length;
  let done = 0;

  for (const action of actions) {
    if (action.verification_mode === "manual") {
      if (typeof action.done_at === "string" && action.done_at.length > 0) {
        done += 1;
      }
    } else {
      const reading = readings[action.action_key];
      if (reading && reading.state === "satisfied") {
        done += 1;
      }
    }
  }

  return { done, total, complete: total > 0 && done === total };
}
