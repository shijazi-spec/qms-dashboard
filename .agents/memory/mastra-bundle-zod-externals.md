---
name: Mastra bundle zod v3/v4 skew
description: Why zod must be in bundler.externals — prod-only startup crash in zod v4 toJSONSchema on v3 schemas
---

# Mastra prod bundle: zod must be externalized

`zod` must stay in `bundler.externals` in `src/mastra/index.ts` (alongside `@mastra/core`).

**Symptom (deploy-only):** build succeeds, but the production container crash-loops on
startup with `TypeError: Cannot read properties of undefined (reading 'def')` at
`zod/v4/core/to-json-schema.js` (`schema._zod.def`). Health check returns 500 → promote fails.
Dev (`mastra dev`) is fine — the crash is prod-bundle-only.

**Why:** Mastra/AI packages peer-depend on `zod: "^3.25.0 || ^4.0.0"`. The prod bundle
installs its **externalized** deps from a Mastra-generated `.mastra/output/package.json` that
does NOT carry over the workspace npm `overrides`. If `zod` is not externalized it is bundled
into `index.mjs` (as v3) but is absent as a top-level dep in the generated manifest — so the
fresh install picks the **highest** range match (zod **v4**) for externalized `@mastra/core`.
`@mastra/core` then calls zod-v4 `toJSONSchema()` on the v3-authored schemas (no `._zod`
internal) → crash. Dev avoids it only because everything dedupes to the single workspace zod.

**How to apply:** keep `"zod"` in `bundler.externals`. This makes Mastra write `zod` (at the
workspace version) as a top-level dep in the generated manifest, so the bundle install resolves
ONE shared zod 3.25.x that both the app schemas and `@mastra/core` dedupe to. You do NOT need
to externalize every zod-using package — only ensure `@mastra/core` can't resolve a different
zod major than the schema authorship version. Keep zod pinned on the v3 line; treat a v4
migration as a separate end-to-end schema task.

**Verify fast (no full boot needed):** run the build far enough to write
`.mastra/output/package.json` and confirm it lists `zod` as a top-level dependency. A single
shared zod 3.25.x passes Mastra schema registration at startup.

**Gotcha:** local full-bundle boot verification is hard here — detached builds get reaped at
the tool-call boundary, foreground `mastra build` exceeds the 120s tool timeout, and
`clean:mastra` fights the running `mastra dev` over `.mastra/output` (see mastra-dev-build-cache).
