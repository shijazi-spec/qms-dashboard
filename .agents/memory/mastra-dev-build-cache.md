---
name: Mastra dev build-cache boot failure
description: "mastra dev" fails to boot with an inngest index.js vs index.cjs ESM/CJS resolution error — fix by clearing .mastra/output
---

# Mastra dev `.mastra/output` stale build cache

Symptom: `npm run dev` (`mastra dev`) exits immediately (workflow shows FINISHED, not running) with:

```
ERROR (Mastra CLI): Cannot find package '.../.mastra/output/node_modules/inngest/index.js'
imported from '.../.mastra/output/server-config.mjs'
Did you mean to import "inngest/index.cjs"?
```

The bundled `server-config.mjs` resolves `inngest/index.js` but the bundled copy only ships `index.cjs` (ESM/CJS mismatch baked into the build output).

**Fix:** `rm -rf .mastra/output` then restart the workflow — Mastra regenerates the output dir cleanly and boots. A plain restart does NOT fix it; the cache must be deleted.

**Why:** `.mastra/output` is a regenerated build artifact dir. A stale/corrupt bundle (often after a merge/reconciliation) pins the bad import. Deleting it is safe.

**How to apply:** When the dev server won't boot and the error points at `.mastra/output/...`, clear that dir first before investigating code. Also a candidate for the post-merge setup script if it recurs after merges.
