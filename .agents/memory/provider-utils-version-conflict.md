---
name: provider-utils @ai-sdk version conflict (build vs security)
description: Why @ai-sdk/provider-utils must be split v3/v4 in package.json overrides; a global v4 override breaks the publish build.
---

# @ai-sdk/provider-utils: build-vs-security conflict

There is an **irreconcilable tension** between the `mastra build` (publish) build and
the GHSA-866g-f22w-33x8 advisory in the current `ai@5` / `@mastra/*` stack.

## The conflict
- **Build needs v3.** `ai@5.x`, `@ai-sdk/gateway@2.x`, the `@mastra/core` `ln` alias, and the
  `@ai-sdk/openai-v5` alias all import **`lazyValidator`** from `@ai-sdk/provider-utils`.
  `lazyValidator` exists in **v3** and was **removed in v4**. `mastra dev` skips rollup static
  analysis so it tolerates a mismatch, but **`npm run build` / `mastra build` does the analysis
  and fails** with: `"lazyValidator" is not exported by .../@ai-sdk/provider-utils, imported by .../@ai-sdk/gateway`.
- **Security wants v4.** GHSA-866g-f22w-33x8 (low-sev, CVSS 4.3, authenticated DoS / CWE-400)
  affects **`<=3.0.97`** — i.e. the **entire v3 line is vulnerable** (3.0.26 included). The fix
  exists **only in v4 (4.x)**. `npm audit`'s only `fixAvailable` is a **semver-major** AI-SDK upgrade.

So you cannot satisfy both at the same provider-utils version with the current ecosystem.

## What works (current decision)
Per-major-line npm overrides in `package.json` (npm 10.8.2 supports version-selector keys):
```
"@ai-sdk/provider-utils@3": "3.0.26",   // latest v3, exports lazyValidator -> build links
"@ai-sdk/provider-utils@4": "4.0.29"    // patched v4 floor for v4-capable consumers
```
**Why:** A single global `"@ai-sdk/provider-utils": "^4.0.29"` force-collapses every instance to
v4 and **breaks the publish build** (this is exactly what a "fix N vulnerabilities" commit did).
Scoping by major keeps v3 consumers buildable while pinning v4 consumers to a patched v4.

## Gotchas / do-NOT
- **Do NOT "fix" the npm audit finding by forcing provider-utils to v4 globally** — it re-breaks
  publish. The residual low-sev advisory on the v3 chains is unavoidable without a major upgrade.
- **Do NOT assume any 3.0.x is "patched"** — the whole v3 line is in-range. 3.0.26 is chosen only
  because it's the latest v3 and still exports `lazyValidator`, not because it's patched.
- Full remediation = coordinated **major** upgrade of `ai` + `@ai-sdk/*` + `@mastra/*` to a line
  whose consumers use a v4 provider-utils that restored `lazyValidator` (or dropped the import).
  That is a major dependency change — get user sign-off first (replit.md preference).
