---
name: Postgres EXPLAIN test determinism
description: How to keep index-capability regression tests stable when they run against a shared database with changing live data.
---

When a regression test exists to prove that a query *can* use a specific
Postgres index, do not let the assertion depend on whatever row distribution
and planner statistics happen to exist in the shared development database.
Use a dedicated connection and transaction-local planner control (for example,
disable sequential scans only for that EXPLAIN transaction), then assert that
the expected index appears.

**Why:** Live data growth changed selectivity enough that Postgres correctly
preferred a sequential scan, even though the required partial index still
existed and supported the query. Seed-size tuning passed alone but failed when
the full suite ran against the busier shared database.

**How to apply:** Use this only for index-*capability* tests. Performance tests
that intend to validate the planner's natural cost choice should instead run
against isolated, controlled statistics and must not force a scan type.