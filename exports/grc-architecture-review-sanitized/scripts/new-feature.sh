#!/usr/bin/env bash
# Start a new feature branch from the latest origin/QMS.
#
# Usage:
#   bash scripts/new-feature.sh feat/duplicate-radar-sort-by-confidence
#
# Validates the branch-name prefix against the conventions in CONTRIBUTING.md
# and refuses to start from a dirty working tree.

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: bash scripts/new-feature.sh <branch-name>" >&2
  echo "Example: bash scripts/new-feature.sh feat/duplicate-radar-sort-by-confidence" >&2
  exit 1
fi

BRANCH="$1"

# Allowed prefixes per CONTRIBUTING.md
case "$BRANCH" in
  feat/*|fix/*|hotfix/*|chore/*|docs/*|refactor/*|test/*|epic/*|cost/*) ;;
  *)
    echo "ERROR: branch name must start with one of:" >&2
    echo "  feat/  fix/  hotfix/  chore/  docs/  refactor/  test/  epic/  cost/" >&2
    echo "Got: $BRANCH" >&2
    exit 1
    ;;
esac

# Refuse if working tree is dirty — would silently carry WIP onto the new branch
if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: working tree is not clean. Commit or stash first." >&2
  git status --short >&2
  exit 1
fi

# Refuse if branch already exists locally
if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  echo "ERROR: branch '$BRANCH' already exists locally." >&2
  exit 1
fi

echo "→ Fetching latest origin/QMS..."
git fetch origin QMS

echo "→ Creating $BRANCH from origin/QMS..."
git checkout -b "$BRANCH" origin/QMS

echo ""
echo "✓ On branch $BRANCH (based on latest origin/QMS)"
echo ""
echo "When done, ship with:"
echo "  bash scripts/ship-feature.sh \"<commit message>\""
