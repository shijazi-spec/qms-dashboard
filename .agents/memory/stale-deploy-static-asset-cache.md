---
name: "Stale deploy" reports for dashboard static JS/CSS
description: When a user says the deployed dashboard serves OLD JS/CSS despite republishing, suspect browser caching of validator-less static assets before assuming a stale build.
---

# "Stale deployment" of dashboard static assets is usually browser cache, not the build

When a user reports the deployed app serves an OLD copy of a dashboard JS/CSS file
(e.g. "the function I added is missing in prod") and "Republish says no code changes":

**Verify ground truth before forcing any rebuild.** `curl` the live asset URL directly
and grep for the new symbol. If the SERVER returns current code, the deploy is fine and
a clean rebuild changes nothing — the staleness is in the user's **browser cache**.
Immediate remedy: hard refresh / private window.

**Why it happened:** large externalised dashboard assets were served with NO cache
validators (no ETag / Last-Modified), some with `max-age`. Browsers then heuristically
cache and keep serving an old build's asset. Durable fix applied: serve a content-hash
strong `ETag` + `Cache-Control: no-cache` and honor `If-None-Match` → `304`.

**Gotcha — don't trust commit-vs-build timestamps to "prove" staleness:** "Published
your App" checkpoints are content-identical markers to their parent commit
(`git diff HEAD~1 HEAD` empty), and a build's recorded create-time can predate the
checkpoint SHA it actually produced. Curl the live asset; that's the only ground truth.

**Gotcha — watch for route shadowing:** a broad `/dashboard/:name` catch-all can serve
the same path as a more specific asset route and win, so fixing only the specific route
leaves the asset stale. Fix the handler that actually serves the bytes.
