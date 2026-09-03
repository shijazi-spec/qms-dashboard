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

## Writing permission rules for this repo

`Bash(foo:*)` is exactly equivalent to `Bash(foo *)` — it requires a **space** after
`foo`. It does NOT match `foo:bar`. So `Bash(npm run check:*)` matches `npm run check`
but *not* `npm run check:all`.

Drop the colon to cover script-name variants: `Bash(npm run check*)` (no space) matches
`npm run check`, `npm run check:all`, and `npm run check --flag`.

Rules are evaluated **deny -> ask -> allow**, first match wins, and each subcommand of a
compound command must match independently. Output redirection is checked separately
against `Edit` rules, so `npm run check > out.txt` needs write permission for `out.txt`.
