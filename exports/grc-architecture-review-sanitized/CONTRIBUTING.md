# Contributing — Branching & Workflow

This repo deploys to HostingPlatform on every push to `QMS`. That makes the branching
model your only safety net between "I typed it" and "it's live." Pick the
right pattern per change.

---

## Decision tree

```
Am I about to make this change?
│
├── True one-liner (typo, color, copy, single CSS class)
│   → Pattern A — commit straight to QMS
│
├── One feature, ≤ 3 days, contained blast radius
│   → Pattern B — short feature branch, squash-merge   ← DEFAULT
│
├── Multi-week module, useless until fully done
│   → Pattern C — epic branch
│
└── Prod is broken right now
    → Pattern D — hotfix branch
```

**80/20 rule:** ~70% of your work should be Pattern B. ~20% Pattern A. ~10%
C or D combined. If you're using C more than once a month, you need feature
flags instead.

---

## Pattern A — Direct to `QMS`

**When:** Single-file cosmetic / copy / typo fix that you'd be happy typing
straight into HostingPlatform Shell.

**Examples from this repo:**
- `fix(branding): PMP Project Portfolio H1 in green`
- `fix(branding): catch 2 blue/indigo gradients prior sweep missed`

**Flow:**
```sh
git checkout QMS
git pull origin QMS
# edit
git add <file>
git commit -m "fix(area): one-line description"
git push origin QMS
```

**Don't use Pattern A for:** anything touching auth, RBAC, payments, AI
prompts, database migrations, cost-sensitive code paths (LLMProvider calls,
CRMProvider writes), or anything that touches more than 2 files.

---

## Pattern B — Short feature branch (DEFAULT)

**When:** One feature, contained, you can finish it in ≤ 3 days. Most of
what you build day-to-day.

**Examples from this repo:**
- `feat/duplicate-radar-action-log-timeline`
- `feat/inline-audio-playback`
- `feat/coaching-loop-closure`
- `fix/scorecard-summary-uses-wrong-endpoint`

**Flow:**
```sh
# Start
bash scripts/new-feature.sh feat/duplicate-radar-sort-by-confidence

# Work — commit as often as you want (these are throwaway commits)
git add . && git commit -m "wip: sort logic"
git add . && git commit -m "wip: ui toggle"

# Ship — squash-merges into QMS, pushes, deletes the branch
bash scripts/ship-feature.sh "feat(duplicate-radar): sort clusters by confidence"
```

**Rules:**
- Branch lifetime ≤ 3 days. If it's taking longer, you're building something
  that's actually Pattern C.
- Squash-merge into `QMS`. One feature = one commit on `QMS` = `git revert`
  is one command.
- Delete the branch immediately after merge. Both locally and on remote.
- Push to SourceControlProvider even if you're not opening a PR (the dangling commits we
  cleaned up on 2026-05-24 were lost because they only existed locally).

---

## Pattern C — Epic branch

**When:** Multi-week work across many sub-features where partial landings
would ship half-done features to prod.

**Examples that would fit:**
- `epic/iso-27001-seed` (100+ clause inserts + docs mapping + dashboard wiring)
- `epic/ContactCenterProvider-real-ingest` (stub → real, webhook handler, retries, secrets)
- `epic/rbac-v2` (any platform-wide auth refactor)

**Flow:**
```sh
# Create the epic from latest QMS
git checkout QMS && git pull origin QMS
git checkout -b epic/iso-27001-seed
git push -u origin epic/iso-27001-seed

# Sub-features branch off the epic, merge back to the epic (NOT QMS)
git checkout epic/iso-27001-seed
git checkout -b feat/iso-27001-clause-A.5
# ...work, merge back to epic/iso-27001-seed

# Weekly: rebase the epic onto latest QMS
git checkout epic/iso-27001-seed
git rebase origin/QMS
git push --force-with-lease origin epic/iso-27001-seed

# When the whole epic is done: merge to QMS as one coordinated landing
git checkout QMS && git pull origin QMS
git merge --no-ff epic/iso-27001-seed
git push origin QMS
git branch -d epic/iso-27001-seed
git push origin --delete epic/iso-27001-seed
```

**Discipline required:** Rebase weekly. If you can't keep up, the work is
too big — split it, or build a feature flag and use Pattern B instead.

---

## Pattern D — Hotfix

**When:** Prod is broken and you need a fix without grabbing whatever else
is in flight on your other branches.

**Examples from this repo:**
- `hotfix/ai-sdk-v5-chat-completions-adapter`
- `hotfix/analyze-all-pending-broken`
- `hotfix/compliance-judge-v3-spec`

**Flow:**
```sh
# Branch off origin/QMS (not your local — local might have other WIP)
git fetch origin
git checkout -b hotfix/<name> origin/QMS

# Fix, test, ship
bash scripts/ship-feature.sh "fix(area): hotfix description"
```

---

## Branch naming conventions

| Prefix | Meaning |
|---|---|
| `feat/` | New user-facing feature |
| `fix/` | Bug fix to existing feature |
| `hotfix/` | Production-breaking bug, urgent |
| `chore/` | Tooling, dependencies, non-user-facing cleanup |
| `docs/` | Documentation only |
| `refactor/` | Restructuring without behavior change |
| `test/` | Test-only changes |
| `epic/` | Long-lived multi-feature branch |
| `cost/` | Cost-impact change (model swap, API change) |

`scripts/new-feature.sh` enforces these prefixes.

---

## Commit message format

Match the existing repo style:

```
<type>(<scope>): <subject>

<optional body explaining WHY>
```

Examples:
- `feat(duplicate-radar): cross-module overlaps tab (R6)`
- `fix(cs-overlap): don't silently mislabel custom active phases as 'renewal'`
- `cost: switch analysis + SDR-eval from gpt-4o to gpt-4o-mini (~75% cheaper)`

---

## The "never directly to QMS" list

These ALWAYS go through Pattern B (or C):

- Anything touching `src/utils/rbac*`, `src/utils/auth*`, `src/utils/sessionCookie*`
- Schema changes (any `CREATE TABLE`, `ALTER TABLE`, `DROP COLUMN`)
- AI agent prompts (`src/mastra/agents/*`)
- AI tool implementations (`src/mastra/tools/*`)
- Anything calling LLMProvider/Anthropic in a new code path
- Anything touching CRMProvider CRM writes
- `package.json` dependency changes
- Anything in `scripts/` that's wired into a hook or CI
- Anything in `.HostingPlatform`, `.husky/`, `.githooks/`

If you're not sure, branch it.

---

## Scripts

| Script | Purpose |
|---|---|
| `scripts/new-feature.sh <branch-name>` | Start a new branch from latest `origin/QMS`, with naming validation |
| `scripts/ship-feature.sh "<commit message>"` | Squash-merge current branch into `QMS`, push, delete local + remote branch |

Also wired as:
- `npm run new-feature -- <branch-name>`
- `npm run ship -- "<commit message>"`

---

## When to use a feature flag instead of branching

The flag helper lives at `src/utils/featureFlags.ts`. Use it when you
want to:

- Push code to `QMS` (deployed) hidden behind `if (isFlagEnabled('x', user.email))`
- Test by enabling for your own user only (set `<FLAG>_USERS=<REDACTED_EMAIL>` in HostingPlatform Secrets)
- Flip on globally when ready (`<FLAG>=true`)
- Flip off instantly if it breaks — no revert, no redeploy (`<FLAG>=false`)

### Adding a new flag

1. Add it to the `FLAGS` map in `src/utils/featureFlags.ts`
2. Gate the code at the call site:
   ```ts
   import { isFlagEnabled } from "../utils/featureFlags";

   if (isFlagEnabled("my_new_thing", currentUser?.email)) {
     // new path
   } else {
     // old path
   }
   ```
3. Set the env var in **HostingPlatform Secrets** (NOT in `.HostingPlatform` or committed env files)
4. Test with `<FLAG>_USERS=your_email` first, then flip global when confident

For a platform with auto-deploy and no staging, the flag helper is the
single highest-leverage piece of safety infrastructure you have. Reach
for it before reaching for Pattern C (epic branches).
