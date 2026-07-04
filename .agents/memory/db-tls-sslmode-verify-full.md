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
no `sslmode`.

**Strongest fix = normalize at the callsite, not via env side-effect.** Two hard
facts drive this:
1. **pg ignores an explicit `ssl` option when a `connectionString` is present.**
   Passing `new Pool({ connectionString, ssl: { rejectUnauthorized:false } })`
   does NOT override — pg keeps the ssl parsed from the connection string. The
   ONLY thing that works is rewriting the string's `sslmode` itself. (Empirically
   confirmed: `sslmode=require` → pg builds `ssl:{}` = verify-full AND prints the
   warning; `sslmode=no-verify` → `ssl:{rejectUnauthorized:false}`, no warning.)
2. **Side-effect env mutation is bundler-order-fragile (see recurrence above).**
   The bundle can construct a module-scope pool before the env is rewritten, and
   a lazy pool still *captures* the un-normalized string at construction and only
   fails on its first query at request time.

So `normalizeDatabaseUrl.ts` also exports a pure, idempotent
`normalizeSslMode(raw): string | undefined` (returns `undefined` for undefined
input to preserve pg's PG*-env fallback). Apply it directly in the pool
expression: `new Pool({ connectionString: normalizeSslMode(process.env.DATABASE_URL) })`.
This is immune to import/eval ordering because it's a pure call in the same
expression. The fatal boot path (`src/mastra/storage/index.ts` → PostgresStore)
uses this, as do the highest-traffic module-scope pools (`rbacMiddleware`
platformPool, `aiApprovalDatabase`, `duplicateRadarDatabase`). Importing a
NAMED export still runs the module's top-level side-effect, so swapping
`import "./normalizeDatabaseUrl"` → `import { normalizeSslMode } from …` loses
nothing.

**Still-open follow-up:** dozens of other `src/utils/*` module-scope pools and
route-handler pools still read raw `process.env.DATABASE_URL`. They're the same
fragility class; sweep them to callsite `normalizeSslMode(...)` (or a single
normalized pool factory) to fully close it. Prior partial fix pattern (add
`import "./normalizeDatabaseUrl";` as the FIRST import of each pool module) is a
weaker fallback that only fixes intra-module ordering.

**How to apply:** if a managed-DB app crash-loops on TLS after a `pg` bump,
check whether the prod connection string uses `sslmode=require` and whether the
driver now treats it as `verify-full`; restore non-strict verification rather
than chasing per-pool `ssl` options. `no-verify` keeps encryption but disables
cert authenticity (slight MITM-resistance downgrade) — acceptable as the
status-quo-ante for managed DBs on trusted infra.
