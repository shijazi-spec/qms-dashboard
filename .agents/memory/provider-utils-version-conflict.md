---
name: provider-utils @ai-sdk version conflict (build vs security)
description: How legacy AI SDK v5 consumers run safely without installing vulnerable provider-utils v3.
---

# @ai-sdk/provider-utils: secure legacy compatibility

Legacy AI SDK v5 packages still request provider-utils v3, but no v3 release is
patched for GHSA-866g-f22w-33x8. The v3 line also introduces a vulnerable Undici path.

## The conflict
- **Legacy consumers need removed v3 exports.** They statically import validator helpers and
  provider-defined tool factories that v4 no longer exports.
- **Security needs v4.** Updating to the latest v3 does not fix the advisory.
- **The deploy artifact is a separate dependency tree.** Mastra generates its own manifest
  without root overrides, so auditing only the workspace can give a false green result.

## Current decision

Resolve legacy requests to a patched v4 release and provide only the removed compatibility
exports. Ensure Mastra's separately generated deployment dependency tree inherits the same
security constraints and is audited as part of every production build.

**Why:** This removes the vulnerable packages while preserving the static API surface required
by the current Mastra/AI SDK v5 consumers.

**How to apply:** Require zero production audit findings in both the workspace and generated
artifact, assert no provider-utils v2/v3 remains, and run type-check plus the production build.

## Gotchas / do-NOT
- Do not restore provider-utils v3; no 3.0.x release is a security fix.
- Do not remove the compatibility layer while legacy AI SDK v5 packages remain.
- Do not trust the root audit alone; the generated deployment directory must also audit cleanly.
