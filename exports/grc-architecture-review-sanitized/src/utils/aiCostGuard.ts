/**
 * AI spend circuit-breaker — pauses LLMProvider/Whisper/Anthropic calls when
 * estimated daily spend hits a configurable cap.
 *
 * Why this exists: the 2026-05-12 incident — LLMProvider prepaid balance hit
 * zero, every analysis silently failed for ~3 hours, no alerting. Per
 * DMAIC Improve phase Solution #9 and Control phase: target ≥ 7-day
 * LLMProvider balance runway with a daily cap to prevent runaway spend.
 *
 * Behavior (when enabled):
 *   - Tracks estimated USD per day in-memory (resets on process restart,
 *     which is fine because HostingPlatform redeploys regularly enough to make
 *     persistence overkill — this is a guardrail, not an accounting
 *     system).
 *   - Before each costly call, the call-site checks isCostCapped().
 *     If true, the caller should short-circuit with a 503-style error
 *     (e.g. status='cost_capped' on the call_records row, surfaced in
 *     the UI as "analysis paused — daily cap reached").
 *   - After each call, the call-site invokes recordSpend(usd, op) so the
 *     counter advances.
 *
 * Feature-flagged: enforcement only runs when COST_CIRCUIT_BREAKER=true.
 * Until you've validated the estimates against real billing data, leave
 * the flag off and let recordSpend() accumulate without blocking — that
 * gives you a free dry-run of how much the platform would spend.
 *
 * Estimates (rough; verify against your LLMProvider usage dashboard):
 *   - WHISPER_TRANSCRIBE: $0.006/min audio → assume 90s avg call → $0.01
 *   - GPT4O_MINI_ANALYZE: ~600 input + 400 output tokens → ~$0.0003
 *   - GPT4O_MINI_SDR_EVAL: ~1500 input + 500 output tokens → ~$0.0006
 *
 * Tune the constants below as you measure real usage.
 *
 * Usage at the call site:
 *
 *   import { isCostCapped, recordSpend, COST } from "../utils/aiCostGuard";
 *
 *   if (isCostCapped()) {
 *     await updateCallRecord(callId, { status: "pending",
 *       ai_insights: JSON.stringify({ paused_reason: "daily_cap_reached" }) });
 *     return { status: "cost_capped" };
 *   }
 *
 *   const result = await LLMProvider.audio.transcriptions.create({...});
 *   recordSpend(COST.WHISPER_TRANSCRIBE, "whisper_transcribe");
 */

import { isFlagEnabled } from "./featureFlags";
import { logger as safeLogger } from "./logger";

/** Default cap when LLMProvider_DAILY_CAP_USD is unset. */
const DEFAULT_DAILY_CAP_USD = 50;

/**
 * Estimated USD cost per operation. Hand-tuned starting estimates;
 * adjust as you compare against actual LLMProvider billing.
 */
export const COST = {
  WHISPER_TRANSCRIBE: 0.01,
  GPT4O_MINI_ANALYZE: 0.0003,
  GPT4O_MINI_SDR_EVAL: 0.0006,
  GPT4O_MINI_COMPLIANCE: 0.0004,
} as const;

export type CostOperation = keyof typeof COST | string;

interface DailyState {
  /** YYYY-MM-DD in UTC. */
  day: string;
  totalUsd: number;
  /** Count of operations, useful for diagnostics. */
  ops: Record<string, { count: number; usd: number }>;
}

let state: DailyState = freshState();

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function freshState(): DailyState {
  return { day: todayUtc(), totalUsd: 0, ops: {} };
}

function rollIfNewDay(): void {
  const t = todayUtc();
  if (state.day !== t) {
    safeLogger.info("[aiCostGuard] rolling daily counter", {
      previous_day: state.day,
      previous_total_usd: state.totalUsd,
      previous_ops: state.ops,
    });
    state = freshState();
  }
}

function readCapUsd(): number {
  const raw = process.env.LLMProvider_DAILY_CAP_USD;
  if (!raw) return DEFAULT_DAILY_CAP_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DAILY_CAP_USD;
  return n;
}

/**
 * Returns true when:
 *   (a) the feature flag COST_CIRCUIT_BREAKER is enabled, AND
 *   (b) today's estimated spend has reached or exceeded the cap.
 *
 * Returns false in dry-run mode (flag off) so existing call sites keep
 * working while you tune the estimates against real billing.
 */
export function isCostCapped(): boolean {
  if (!isFlagEnabled("cost_circuit_breaker")) return false;
  rollIfNewDay();
  return state.totalUsd >= readCapUsd();
}

/**
 * Record that an operation just consumed `usd` of estimated spend.
 * Always increments the counter — even when the flag is off — so you
 * can run in dry-run mode and observe what would have been capped.
 */
export function recordSpend(usd: number, operation: CostOperation): void {
  if (!Number.isFinite(usd) || usd <= 0) return;
  rollIfNewDay();
  state.totalUsd += usd;
  const opKey = String(operation);
  if (!state.ops[opKey]) state.ops[opKey] = { count: 0, usd: 0 };
  state.ops[opKey].count += 1;
  state.ops[opKey].usd += usd;
}

/**
 * Diagnostic snapshot — safe to expose on an admin endpoint.
 * Does not consult the feature flag (you always want to see the
 * counter, even when not enforcing).
 */
export function getSpendSnapshot(): {
  day: string;
  total_usd: number;
  cap_usd: number;
  cap_enforced: boolean;
  pct_of_cap: number;
  ops: Record<string, { count: number; usd: number }>;
} {
  rollIfNewDay();
  const cap = readCapUsd();
  return {
    day: state.day,
    total_usd: Math.round(state.totalUsd * 10000) / 10000,
    cap_usd: cap,
    cap_enforced: isFlagEnabled("cost_circuit_breaker"),
    pct_of_cap:
      cap > 0 ? Math.round((state.totalUsd / cap) * 10000) / 100 : 0,
    ops: state.ops,
  };
}

/**
 * Test helper — resets the in-memory state. Should not be called
 * from production code. Exported so vitest tests can isolate runs.
 */
export function _resetCostGuardForTests(): void {
  state = freshState();
}
