# qms-dashboard

## Shell command rule: never start a command with `cd`

Claude Code matches permission rules against the **entire command string**. A
command like `cd "/some/path" && npm run check` can never match `Bash(npm run check:*)`,
so every `cd`-prefixed command prompts again, forever, and each approval writes a
dead one-off entry into `.claude/settings.local.json`.

**Do not work around this with a blanket allow.** Instead:

| Instead of | Write |
|---|---|
| `cd <repo> && git status` | `git -C "<repo>" status` |
| `cd <pkg> && npm run check` | `npm --prefix "<pkg>" run check` |
| `cd <dir> && cat file.txt` | `cat "<dir>/file.txt"` |
| `cd <dir> && ls` | `ls "<dir>"` |

Use absolute paths for everything else. If a tool genuinely has no
directory flag, run it from a session already rooted in the right directory
rather than chaining `cd`.

## This repo

Run Claude Code from this directory (`D:/2_QMS Platform/qms-dashboard`), not from
the parent — the permission rules in `.claude/settings.local.json` only load at
this root.

Allowlisted without prompting:

- `npm run build` — clean + `mastra build` + dependency hardening
- `npm run check` and every `check:*` variant (`tsc`, tests, format, html-js, schema-parity, rbac, lockfile, `check:all`)
- `npm run qc` — platform QC runner
- `npm test` — integration tests
- `git add` / `git commit` / `git push` / `git rebase`

Deliberately **not** allowlisted (these still prompt): `npm install`, `npm ci`,
`npm run format` (rewrites sources), `npm run ship`, `npm run new-feature`, `git rm`, `git reset`.

## This working tree is often SHARED by two agent sessions at once

Assume another session is editing these same files right now. On 2026-09-11/12
two sessions ran here together and each of the following actually happened.

**Never `git commit` bare. Commit your own paths only:**

```
git commit -o <path> [<path> …] -F -
```

A bare `git commit` commits the whole INDEX, and the index is shared. The other
session's staged work — including a staged file DELETION — sat there twice while
a bare commit was one keystroke away from swallowing it into an unrelated change.
Run `git status --short` first and confirm every staged entry is yours.

**Your edits may be committed by someone else.** Uncommitted changes in this tree
were twice swept into the other session's commit, landing under a message about
something unrelated. If `git commit` reports "nothing to commit" and your change
is present in the file, check `git log -S'<a string you added>'` before redoing
the work.

**Expect your CI run to be cancelled.** Pushes land every few minutes and the
suite takes ~4, so runs are superseded constantly — four in a row on that night.
Never report a branch as green from a run that was `cancelled`, and never from
the commit *before* yours. Verify on a run that COMPLETED on a commit that
contains your change.

**Before saying "ready to publish", prove the workspace sha.** See
`git fetch` then `git log --oneline -1`; "Already up to date" is measured against
a local remote-tracking ref that goes stale on its own and once failed to update
at all (`cannot lock ref 'refs/remotes/origin/QMS'`).

Better than all of the above: give each session its own `git worktree` so the
index is not shared.

## Writing permission rules for this repo

`Bash(foo:*)` is exactly equivalent to `Bash(foo *)` — it requires a **space** after
`foo`. It does NOT match `foo:bar`. So `Bash(npm run check:*)` matches `npm run check`
but *not* `npm run check:all`.

Drop the colon to cover script-name variants: `Bash(npm run check*)` (no space) matches
`npm run check`, `npm run check:all`, and `npm run check --flag`.

Rules are evaluated **deny -> ask -> allow**, first match wins, and each subcommand of a
compound command must match independently. Output redirection is checked separately
against `Edit` rules, so `npm run check > out.txt` needs write permission for `out.txt`.
