---
name: supabaseBackup mirror must NOT redact secrets
description: Why the weekly Supabase backup writer is exempt from the secret-leak redaction rule
---

# supabaseBackup is a faithful mirror — redaction is forbidden here

`src/utils/supabaseBackup.ts` (`runSupabaseRefresh`) is a whole-database
disaster-recovery MIRROR: it reads every row already stored in the live Postgres
and replicates it verbatim into the org's own Supabase fallback DB.

The platform's DB-writer secret-leak gate (`scripts/check-db-test-coverage.sh` +
`src/utils/README.md`) normally requires every `INSERT`/`UPDATE` writer to scrub
deny-list secrets via `redactSensitiveDeep` before the params vector. **This writer
is the deliberate exception — it must copy secrets verbatim, NOT redact them.**

**Why:** redacting a backup is a correctness/availability bug, not a security win.
A restored snapshot whose `password_hash` / `mfa_secret` had become
`***REDACTED***` would lock every user out and destroy the very data the backup
exists to protect. The data is not newly introduced by this module (it's already
in Postgres), so mirroring it to the same org's secured fallback does not widen
exposure.

**How to apply:** the genuine security property to uphold here is injection-safety,
not redaction. The companion `src/utils/supabaseBackup.test.ts` therefore asserts
(a) every row value travels as a BOUND `$N` parameter (never interpolated into SQL
text) and (b) the mirror copies faithfully with NO redaction sentinel present. Do
NOT "fix" this writer by adding `redactSensitiveDeep` — that would corrupt restores
and the test guards against exactly that regression.
