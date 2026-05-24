/**
 * Feature-flag helper for env-var-backed hidden rollouts.
 *
 * Why this exists: this platform auto-deploys on push to QMS. Long-lived
 * feature branches are the only way to keep risky in-progress work out of
 * prod, but they diverge from QMS and become painful to merge. Flags let
 * you ship code to QMS hidden behind `if (isFlagEnabled('x', user))`,
 * test by enabling for your own user, flip on for everyone when ready,
 * and flip off instantly if it breaks — no revert, no redeploy.
 *
 * Env-var contract (per flag, replace <FLAG> with the env-var name):
 *   - <FLAG>=true/1/on/yes/enabled     → globally enabled for everyone
 *   - <FLAG>=false/0/off/no/unset      → globally disabled (default)
 *   - <FLAG>_USERS=alice@x,bob@y,user:7 → enabled only for those identities
 *     (additive: enabled for those users even when global is off)
 *
 * The identity passed in should match what's in <FLAG>_USERS — typically
 * an email, but a `user:<id>` string also works for the anonymous-with-id
 * case. Pass `null` / `undefined` when no user is known; only the global
 * flag is checked then.
 *
 * Add new flags to the FLAGS map below. Keeping the registry centralized
 * prevents typos like `isFlagEnabled('five9_real_ingets')` from silently
 * returning false forever.
 */

export const FLAGS = {
  // Solutions from the DMAIC Improve phase (2026-05-24). Each maps to an
  // env-var name set in Replit Secrets when the feature is ready to surface.
  five9_real_ingest: "FIVE9_REAL_INGEST",
  lead_history_view: "LEAD_HISTORY_VIEW",
  zoho_structured_fields: "ZOHO_STRUCTURED_FIELDS",
  weekly_digest: "WEEKLY_DIGEST",
  coaching_effectiveness_index: "COACHING_EFFECTIVENESS_INDEX",
  calls_health_dashboard: "CALLS_HEALTH_DASHBOARD",
  cost_circuit_breaker: "COST_CIRCUIT_BREAKER",
} as const;

export type FlagName = keyof typeof FLAGS;

const TRUE_VALUES = new Set([
  "1",
  "true",
  "on",
  "yes",
  "enabled",
]);

function readGlobal(envKey: string): boolean {
  const raw = (process.env[envKey] || "").toLowerCase().trim();
  return TRUE_VALUES.has(raw);
}

function readUsers(envKey: string): string[] {
  return (process.env[`${envKey}_USERS`] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Check whether a feature flag is enabled.
 *
 * @param flag — one of the registered flag names in FLAGS
 * @param identity — the current user's identifier (email or `user:<id>`).
 *   Pass null when no user is known; only the global flag is consulted.
 *
 * @returns true if (a) the global flag is on, OR (b) `identity` is listed
 *   in <FLAG>_USERS. Returns false on unknown flag names (defensive — never
 *   throw at a call site).
 */
export function isFlagEnabled(
  flag: FlagName,
  identity?: string | null,
): boolean {
  const envKey = FLAGS[flag];
  if (!envKey) return false;

  if (readGlobal(envKey)) return true;

  if (!identity) return false;
  const trimmed = identity.trim();
  if (!trimmed) return false;
  return readUsers(envKey).includes(trimmed);
}

/**
 * Diagnostic helper — returns the current state of every registered flag.
 * Useful for an admin page or a /api/admin/feature-flags endpoint.
 *
 * Does NOT consult any specific identity; it just reports the global +
 * per-user-list configuration. Wire up the caller's auth before exposing.
 */
export function listFlagStates(): Record<
  FlagName,
  { envKey: string; global: boolean; users: string[] }
> {
  const result = {} as Record<
    FlagName,
    { envKey: string; global: boolean; users: string[] }
  >;
  for (const name of Object.keys(FLAGS) as FlagName[]) {
    const envKey = FLAGS[name];
    result[name] = {
      envKey,
      global: readGlobal(envKey),
      users: readUsers(envKey),
    };
  }
  return result;
}
