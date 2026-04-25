#!/usr/bin/env bash
# WalaPlus — install local git hooks
# ----------------------------------------------------------------------------
# Points the local clone at the version-controlled `.githooks/` directory so
# that hooks (currently `.githooks/pre-commit`) run on every commit. Wired to
# `npm install` via the `prepare` script in package.json.
#
# Idempotent and safe in any environment:
#   * Skips silently in CI (the guardrails run there via `npm test` already).
#   * Skips silently when the working copy is not a git checkout
#     (e.g. a tarball install, a Docker build context, …).
#   * Always exits 0 so a failure here can never break `npm install`.
# ----------------------------------------------------------------------------

set -u

# Skip in CI — the same guardrails already run there via `npm test` and we do
# not want to mutate the hooks path on ephemeral build agents.
if [ -n "${CI:-}" ]; then
  exit 0
fi

# Skip when there is no git checkout to wire hooks into.
if [ ! -d .git ] && ! git rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

# Use the workspace-relative `.githooks/` path so the value works for every
# contributor regardless of where they cloned the repo.
if git config core.hooksPath .githooks 2>/dev/null; then
  echo "✓ Git hooks installed (core.hooksPath = .githooks)"
  echo "   Active hooks: $(ls .githooks 2>/dev/null | tr '\n' ' ')"
else
  echo "install-git-hooks: could not set core.hooksPath; skipping." >&2
fi

exit 0
