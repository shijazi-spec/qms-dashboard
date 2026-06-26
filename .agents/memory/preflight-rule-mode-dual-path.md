---
name: Preflight has TWO runners (basic vs full) — wire every verdict rule into both
description: duplicateRadarPreflight has two independent classifiers gated by PREFLIGHT_RULE_MODE; production runs BASIC. A rule added only to the full-mode classifier silently never fires in prod and still passes all unit tests.
---

# Preflight basic vs full: wire new verdict rules into BOTH paths

`src/utils/duplicateRadarPreflight.ts` has two completely separate row
classifiers, chosen at runtime by `PREFLIGHT_RULE_MODE`:

- **`classifyPreflightRows`** — the rich "full" ladder. Only runs when
  `process.env.PREFLIGHT_RULE_MODE === "full"`.
- **`runPreflightBasic`** — the "basic" two-rule runner. This is the **default**
  and what **production runs** (the env var is not set to `full` in prod).

`runPreflight` branches: `if (PREFLIGHT_RULE_MODE === "basic") return runPreflightBasic(...)`.

**Rule:** any new verdict / guard / blocklist (e.g. the protected /
do-not-contact named-account check, `matchProtectedAccount`) must be added to
**both** classifiers, or it silently never fires for real users.

**Why:** the protected-account blocklist was added only inside
`classifyPreflightRows`, so in production (basic mode) it never ran — operators
saw no "protected account" verdict even though the function and its data shipped
in the build. This looked exactly like a "stale deployment" but was a
wrong-code-path bug.

**Test trap:** `tests/vitest/duplicateRadarPreflight.vitest.test.ts` is
deliberately scoped to *pure* logic — it exercises `classifyPreflightRows` and
`matchProtectedAccount` directly and explicitly excludes the DB-touching
`runPreflight`/`runPreflightBasic` wrapper. So a rule added only to the full
path passes the entire suite while being dead in prod. When you add/verify a
basic-mode rule, exercise `runPreflight` against the dev DB (basic mode) — the
pure tests will NOT catch a missing wire-up.
