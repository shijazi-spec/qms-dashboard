---
name: Mastra output pins openai to "latest"
description: Generated .mastra/output/package.json declares openai "latest"; pin an exact Node-compatible version in root deps so the harden script overwrites it.
---

Mastra's generated deployment manifest (.mastra/output/package.json) includes `"openai": "latest"` even when the app never imports openai directly. `latest` can jump to a major whose engines.node exceeds the publish runtime (openai 7.x requires Node 22 while the Replit build runs Node 20 → EBADENGINE, future startup risk).

**Fix:** declare `openai` in root package.json dependencies with an **exact** version (no `^`) that supports the runtime (6.49.0 has no engines restriction). scripts/harden-mastra-output-dependencies.mjs copies root dependency specs over the generated ones during `npm run build`, replacing `latest`.

**Why exact:** completion code review rejects a caret range — a fresh install without the lockfile could still pull a Node-22-only release.

**How to apply:** any time a generated-output dep warns EBADENGINE, pin the exact vetted version in root deps and rebuild; verify `.mastra/output/package-lock.json` resolves it and the prod run command (`node --import=./.mastra/output/instrumentation.mjs .mastra/output/index.mjs`, use PORT to avoid 5000 clash) serves /login.

Also: tests/postRestoreSweepPanel.spec.ts deep-link test can fail against a stale dev server — restart the Start application workflow before trusting the failure.
