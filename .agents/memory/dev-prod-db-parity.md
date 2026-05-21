---
name: Dev/prod DB parity for WalaPlus platform_users
description: Why role/user edits in dev never reach prod, and how to make admin assignment survive republishes.
---

Replit Publish copies **schema only**, not data. The deployment's production
database is a separate Postgres instance from the workspace's dev DB. Every
manual UPDATE / INSERT on `platform_users` via the `/users` admin page in the
workspace preview hits the dev DB; the published app at the `*.replit.app`
domain talks to a different DB that those edits never reach.

**Why:** OIDC sign-in defaults new users to `role='department_viewer'` /
`status='pending_approval'` (see `userAccessDatabase.upsertOidcUser`). On a
fresh prod DB this means nobody is admin until someone runs a SQL promotion
against prod directly. Operators routinely re-promote themselves in dev and
assume it propagated — it never does.

**How to apply:** Manage admin assignment via env var, not DB rows. The
`ADMIN_BOOTSTRAP_EMAILS` secret (comma/space-separated) is consumed by
`upsertOidcUser` to auto-promote listed emails to `admin`/`active` on every
OIDC login. Set the same value in dev secrets and deployment secrets so the
two environments converge automatically. For arbitrary data parity (CAPAs,
policies, KPI rows, etc.) there is no built-in sync — a one-off dump/restore
or an export/import endpoint is the only path; do not invent startup-time
data migrations (see `database` skill).
