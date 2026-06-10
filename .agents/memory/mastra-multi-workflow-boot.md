---
name: Adding a 2nd Mastra workflow / cron crashes boot
description: Registering more than one workflow (or cron-triggered workflow) trips two boot-time guards that exit the process before the port opens.
---

Adding a second Mastra workflow to this app crashes the server on boot in two
separate, sequential ways. Fixing only the first surfaces the second, so handle
both together.

1. A single-workflow sanity guard in the Mastra instance setup throws on >1
   registered workflow. It only protected the dev-only Mastra playground UI,
   which this deployment does not use (workflows run via cron/REST). Safe to
   disable — same rationale as the long-disabled agent-count guard (this app
   runs 2 agents by design).
2. The cron-registration helper must give each cron workflow a UNIQUE Inngest
   function id. A shared id makes `inngest.serve()` throw "Duplicate function ID"
   and exit. Keep ids stable/deterministic (derive from the workflow id) so
   Inngest identity survives across deploys; require an explicit workflow id
   rather than an index-based fallback.

**Why it matters:** both failures exit the process before the HTTP port opens,
so the only visible symptom is a deploy healthcheck failure (500 / connection
refused) or a dev "didn't open port 5000" timeout — not an obvious workflow
error unless you read the boot logs. `restart_workflow` port-timeouts during
these crashes are misleading; the process already exited early. Always confirm
the fix by checking boot logs say "mastra ... ready".

**Related:** all cron workflows also share the `replit/cron.trigger` event, so a
manual send of that event fans out to every cron workflow — gate it if that is
undesirable in production.

**Same family — `registerApiRoute()` duplicate ids (a SEPARATE boot crash):**
the `registerApiRoute()` wrapper registers one Inngest function per Hono route
and historically derived its id from only the FIRST path segment. Multiple
routes can share that segment — e.g. two production-wired `/webhooks/slack/*`
registrars (the consultant-rating route plus the newer "Adam" two-way Slack
chat) both collapsed to `api-webhooks` → `inngest.serve()` throws "Duplicate
function ID" at boot, identical symptom to the cron case (deploy healthcheck
500, dev may still boot because the dev playground path doesn't hit the same
serve dedup). Fix: derive the function id from the FULL path
(`apiRouteFunctionId()` -> `api-<full-path-slug>`), but keep the Inngest *event*
name keyed on the first segment so `createWebhook` connectors (e.g.
`/linear/webhook` -> `event/api.webhooks.linear.action`) still match. Guarded by
`tests/inngestApiRouteIds.test.ts` (wired into the `secret-redaction` workflow).
**Why:** adding any 2nd route under an existing first segment silently
reintroduces the collision; the static test fails at CI before it reaches a
deploy.

**Deploy build:** the build is self-cleaning (`rm -rf .mastra/output` before
`mastra build`) because Replit autoscale snapshots the gitignored `.mastra/output`
and a stale populated node_modules makes mastra's non-recursive cleanup fail
with ENOTEMPTY.
