---
name: DB TLS sslmode verify-full crash
description: Why a managed-Postgres deploy can crash-loop on TLS after a pg upgrade, and how DATABASE_URL is normalized at startup.
---

# Managed-Postgres `sslmode=require` → `verify-full` deploy crash

Newer `pg-connection-string` (bundled via `pg`) reinterprets `sslmode=require`
(and `prefer` / `verify-ca`) as `verify-full` — strict TLS certificate-chain
verification. When the managed Postgres cert can't be verified against the
deploy container's CA bundle, the handshake aborts with "Client network socket
disconnected before secure TLS connection was established", the storage layer
throws (`MASTRA_STORAGE_PG_STORE_CREATE_TABLE_FAILED`), and the process exits →
**production crash-loops and every page returns Internal Server Error**.

**Why dev didn't show it:** dev and prod use *different* `DATABASE_URL` values
(secrets are global, but the managed-DB URLs differ). The dev URL carries no
`sslmode`, so dev never triggers verify-full. Tell-tale: prod logs print the
driver warning that `require`/`prefer`/`verify-ca` are aliased to `verify-full`;
dev logs don't.

**Why it surfaced "suddenly":** it only appears on the first successful publish
*after* the pg/pg-connection-string version that changed this behavior — a long
broken-build gap can hide the regression until a deploy finally goes out.

**Fix in this repo:** a side-effect module rewrites `process.env.DATABASE_URL`
`sslmode` `require|prefer|verify-ca` → `no-verify` (encrypted, no cert-chain
verification — restores prior behavior) before any of the many `new Pool(...)`
sites or Mastra's `PostgresStore` (which only accepts a `connectionString`) read
it. Handles BOTH URL-query form (`?sslmode=`/`&sslmode=`) and libpq key/value
DSN form (space-delimited `sslmode=`). No-op when there's no `sslmode`.

**Why:** centralizing at the env var is the only practical way to cover both the
~40 scattered pools and Mastra's internal store in one place.

**Ordering is the only real recurrence risk** — the rewrite must run before the
first DB read. It's imported first in the entry point AND as the first line of
the storage module (the fatal boot path = `PostgresStore.init`), so timing
holds regardless of bundler/import-order. Keep the storage-level import anchor
permanently; do NOT rely solely on entry-point ordering.

**Confirmed recurrence — entry-point ordering is NOT enough for module-scope
pools.** A module that builds a `new Pool()` at module top-level can have that
construction evaluated in the *production* bundle BEFORE the entry point's
normalize side-effect runs. Symptom: every other DB module boots fine but one
module fails with an auth/TLS error at boot (e.g. AI-Approval "Bootstrap
failed: Authentication timed out"), so its page returns a load error while the
rest of the app works. The page being broken is prod-only because dev's URL has
no `sslmode`. **Fix pattern:** add `import "./normalizeDatabaseUrl";` as the
FIRST import (above the `pg`/`Pool` import) of every file that constructs a pool
at module scope — including shared pool factories/wrappers so their many
dependents inherit it. Do not assume the entry-point import covers them.

**How to apply:** if a managed-DB app crash-loops on TLS after a `pg` bump,
check whether the prod connection string uses `sslmode=require` and whether the
driver now treats it as `verify-full`; restore non-strict verification rather
than chasing per-pool `ssl` options. `no-verify` keeps encryption but disables
cert authenticity (slight MITM-resistance downgrade) — acceptable as the
status-quo-ante for managed DBs on trusted infra.
