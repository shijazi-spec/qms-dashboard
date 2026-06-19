---
name: mastra dev sharedPool commonjs interop bundling failure
description: mastra dev (watch) can fail to bundle a pure-ESM file via rollup commonjs interop while mastra build (prod) succeeds — dev-only, does not block deploy
---

# `mastra dev` sharedPool commonjs-interop bundling failure

**Symptom:** `mastra dev` (Start application workflow) fails to boot with a Rollup
error like:

```
RollupError: src/utils/sharedPool.ts?commonjs-es-import (2:9):
  "__require" is not exported by "src/utils/sharedPool.ts",
  imported by ".../sharedPool.ts?commonjs-es-import".
✗ Bundling failed
```

`sharedPool.ts` is pure ESM (`import pg from 'pg'; const { Pool } = pg;`). Rollup's
commonjs plugin (in mastra dev's watch config) synthesizes a `?commonjs-es-import`
proxy for it — because `pg` is a CommonJS package consumed via a default import +
destructure — and that proxy references a `__require` export that doesn't exist.

**Key facts (so a future agent doesn't waste time):**
- `rm -rf .mastra/output` does **NOT** fix this (it is a fresh-rebuild failure, not
  a stale-cache one — distinct from the inngest index.js/cjs cache bug).
- The **production** build is unaffected: `npm run build` (`mastra build`) bundles
  cleanly ("Bundling Mastra done"). It uses a different bundling pass than dev watch.
  So a dev-only sharedPool bundling failure does **NOT** block a deploy.
- It is triggered by any file edit forcing a dev rebuild; it is not caused by the
  edited file. Confirm via `git diff` that the edited file is unrelated.

**How to apply:** If only `mastra dev` is down with this error but `mastra build`
succeeds, treat it as a pre-existing dev-tooling quirk — do NOT hack `sharedPool.ts`
(a core DB pool used everywhere) to chase it, and do not block shipping/deploying an
unrelated fix on it. Verify deployability with `npm run build` (watch for "Bundling
Mastra done"; an EXIT 124 under a short `timeout` is just the later `npm install`
step being cut off, not a bundling failure). Any real remedy belongs in a dedicated
dev-build task (e.g. adjust rollup commonjs handling / use `import { Pool } from 'pg'`),
not as a side effect of feature work.
