---
name: DB-writer secret-leak coverage gate
description: How scripts/check-db-test-coverage.sh works and the non-obvious traps when adding companion tests for src/utils writers
---

# DB-writer secret-leak coverage gate

`scripts/post-merge.sh` runs `scripts/check-db-test-coverage.sh` BEFORE the full suite. It
fails the merge if any `src/utils` file that issues INSERT/UPDATE lacks a companion
`<basename>.test.ts` (existence + wired via npm-test auto-discovery). It also forbids adding
new GRANDFATHERED entries — the proper fix is always to add the redaction + test, never to
grandfather.

**Pattern to satisfy it:** `import { redactSensitiveDeep } from "./eventLogsDatabase"` and wrap
each caller-supplied value with `redactSensitiveDeep(value, "<column>")` before it enters the
`pool.query(..., [...])` params. Reference impl: `src/utils/changeHistoryDatabase.ts` + its
`.test.ts`. Companion tests patch `Pool.prototype.query` BEFORE `await import(...)`, drive each
public writer with deny-list secrets, assert raw secret absent + `***REDACTED***` present, plus
one benign-passthrough (anti-tautology). Tests run via `npx tsx`, `process.exit(1)` on fail.

## Traps
- **Seed-only writers** (functions taking NO caller args, writing hardcoded literals) need no
  source redaction — but STILL need a documenting `.test.ts` (the gate only checks file
  existence), invoking the writer and asserting literals pass through uncorrupted.
- **createRedactedPool false-positives on literal strings.** Modules that write through
  `kpiDatabase`'s pool (`createRedactedPool`) get auto-redaction at the pool layer. That layer's
  heuristic flags benign literals (e.g. a formula string like `Specialist×15%`) as secret-shaped,
  so a seed test must NOT assert "no `***REDACTED***` anywhere" — assert verbatim passthrough on
  specific benign identifiers instead.
- **Read-then-write functions:** the test's mock `query` must return plausible rows (branch on the
  SQL string) so execution actually reaches the INSERT/UPDATE being verified.

**Why:** A merge (security-scan task) crash-looped post-merge solely because 10 new writer files
shipped without companion tests; the gate runs first and masks the rest of the suite until green.
