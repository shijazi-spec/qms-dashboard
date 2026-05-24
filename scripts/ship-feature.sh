#!/usr/bin/env bash
# Squash-merge the current feature branch into QMS, push, and delete the branch.
#
# Usage:
#   bash scripts/ship-feature.sh "feat(area): one-line description"
#
# Safety checks:
#   - Refuses to run on QMS itself
#   - Refuses if working tree is dirty
#   - Refuses if origin/QMS has commits you don't have locally (forces a pull first)
#   - Aborts the squash-merge on conflict and leaves you on QMS to resolve
#
# After success:
#   - You end up on QMS, in sync with origin
#   - The feature branch is deleted locally
#   - The feature branch is deleted on origin (if it exists there)

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: bash scripts/ship-feature.sh \"<commit message>\"" >&2
  echo "Example: bash scripts/ship-feature.sh \"feat(duplicate-radar): sort clusters by confidence\"" >&2
  exit 1
fi

MSG="$1"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

if [ "$BRANCH" = "QMS" ]; then
  echo "ERROR: you are on QMS. Switch to your feature branch first." >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: working tree is not clean. Commit or stash first." >&2
  git status --short >&2
  exit 1
fi

echo "→ Branch to ship: $BRANCH"
echo "→ Commit message: $MSG"
echo ""

echo "→ Fetching latest origin/QMS..."
git fetch origin QMS

# How many commits is origin/QMS ahead of local QMS?
BEHIND="$(git rev-list --count QMS..origin/QMS 2>/dev/null || echo 0)"
if [ "$BEHIND" -gt 0 ]; then
  echo "→ Local QMS is $BEHIND commits behind origin/QMS — fast-forwarding first..."
  git checkout QMS
  git merge --ff-only origin/QMS
  git checkout "$BRANCH"
fi

# Rebase feature branch onto latest QMS so the squash-merge is clean
echo "→ Rebasing $BRANCH onto QMS..."
if ! git rebase QMS; then
  echo "" >&2
  echo "ERROR: rebase has conflicts. Resolve them, then re-run this script." >&2
  echo "To abort: git rebase --abort" >&2
  exit 1
fi

echo "→ Switching to QMS and squash-merging $BRANCH..."
git checkout QMS

if ! git merge --squash "$BRANCH"; then
  echo "" >&2
  echo "ERROR: squash-merge failed. Aborting." >&2
  git reset --hard HEAD >&2
  exit 1
fi

echo "→ Committing squash with message: $MSG"
git commit -m "$MSG"

echo "→ Pushing QMS to origin..."
git push origin QMS

echo "→ Deleting local branch $BRANCH..."
git branch -D "$BRANCH"

# Delete remote branch if it exists
if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
  echo "→ Deleting remote branch origin/$BRANCH..."
  git push origin --delete "$BRANCH"
else
  echo "→ (no remote branch to delete)"
fi

echo ""
echo "✓ Shipped: $MSG"
echo "✓ On QMS, in sync with origin"
echo "✓ Branch $BRANCH deleted (local + remote)"
