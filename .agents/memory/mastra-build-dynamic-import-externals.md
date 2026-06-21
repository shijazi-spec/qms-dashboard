---
name: Mastra build — dynamic-import transitive deps need externals
description: Why `mastra build` fails to bundle a package the app dynamically imports, and the two-part fix
---

`mastra build` (the deploy build) can fail at the "Optimizing dependencies" /
bundling phase with: `We couldn't load "<pkg>" from "<parent>". Make sure
"<pkg>" is installed or add `<pkg>` to your externals.`

**Rule:** any package the app code reaches via `await import("<pkg>")` (or a
lazy `require`) that is only a TRANSITIVE dependency must be (1) listed in
`bundler.externals` in `src/mastra/index.ts`, AND (2) a DIRECT dependency in
package.json.

**Why:** The production `npm install` prunes the tree differently than dev (the
build log shows "removed N packages"), so a transitive package present in dev
can vanish at publish time. The rollup-based bundler then can't resolve the
dynamic import → build fails. Adding it to `externals` stops the bundler from
trying to inline/resolve it; making it a direct dep guarantees it survives the
prune and is in node_modules at runtime. Doing only one of the two leaves either
the build broken (no externals) or runtime broken (not installed).

**Concrete case:** `pg-query-stream` (used by `src/utils/excelExport.ts` for
server-side cursor streaming) came in only via `@mastra/pg → pg-promise`. Fix
was both steps above. `pg` itself was already external — its optional
`pg-query-stream` companion was the gap.

**How to apply:** when a deploy build complains it "couldn't load X from Y",
grep src for a dynamic `import("X")`; if found, add X to externals and promote
it to a direct dependency, then re-run `npm run build` locally to confirm it
clears the "Optimizing dependencies" step.
