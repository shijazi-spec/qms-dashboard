# Replit Secrets Cleanup — Weekly Digest Decommission

**Date:** 2026-05-26
**Owner:** a.amashah@walaplus.com
**Linked decision records:**
- `Decision_Record_Amend_Skip_Digest_Merge_Agent_View_2026_05_25.md` (3rd amendment)
- `Decision_Record_Amend_AI_Only_No_QA_Review_2026_05_25.md` (4th amendment)
**Linked code commit:** `9a11b3e` — *fix: decommission Weekly Slack Digest per 3rd + 4th scope amendments*

---

## Why this checklist exists

The Weekly Digest is now decommissioned at three layers in the codebase:

1. `sendWeeklyDigest()` short-circuits to a no-op
2. `POST /api/calls/weekly-digest/send` returns 410 Gone
3. The Inngest cron registration is commented out

The Slack spam will stop **as soon as Replit republishes the latest commit**.

The env vars below are now dead weight — they're read by nothing. Removing them keeps Replit Secrets clean and prevents a future engineer from thinking the digest is still live based on the env-var presence.

---

## Pre-flight check (do this first)

Confirm Replit has pulled commit `9a11b3e` or later:

```
1. Open Replit → qms-dashboard
2. Open Git pane (left sidebar)
3. Verify "Latest commit on QMS" shows 9a11b3e (or newer)
4. If not, click "Pull" then "Republish"
5. Wait ~30 seconds for the deploy to complete
6. Open Slack → #automatic-audits → confirm no new digest messages
```

Once you confirm no new digest messages are arriving, proceed below.

---

## The three secrets to remove

Open Replit → **Secrets** (left sidebar, lock icon) and delete each of the following keys.

### ☐ 1. `WEEKLY_DIGEST`

- **What it did:** Global feature-flag toggle. When `true`, the digest cron would send. When `false` / unset, the digest was suppressed.
- **Now:** Read by nothing. The decommission guard runs before this flag is even checked.
- **Action:** Click the row → trash icon → confirm delete.

### ☐ 2. `WEEKLY_DIGEST_CRON`

- **What it did:** Overrode the default cron schedule (`0 3 * * 0` = Sunday 03:00 UTC).
- **Now:** The Inngest registration is commented out, so this env var is read by nothing.
- **Action:** Click the row → trash icon → confirm delete.
- **Note:** If you don't see this secret at all, it means you never overrode the default — skip.

### ☐ 3. `WEEKLY_DIGEST_RECIPIENTS`

- **What it did:** Comma-separated list of email recipients for the digest.
- **Now:** Read by nothing.
- **Action:** Click the row → trash icon → confirm delete.

---

## Optional 4th secret (only if not used elsewhere)

### ☐ 4. `SLACK_DIGEST_CHANNEL_ID`

- **What it did:** The Slack channel id where the digest was posted (the `#automatic-audits` channel).
- **Caveat:** This secret is also referenced as a fallback for some other Slack notification paths. **Only delete if you've confirmed nothing else uses it.**
- **Safe action:** Leave in place unless you're sure. The decommission guards make it harmless to keep.

---

## After deletion

1. **Don't** click Republish — env-var deletions don't require a restart. The app is already ignoring these.
2. Confirm in Replit → Secrets that the three rows are gone.
3. Confirm in Slack `#automatic-audits` that no new digest messages arrive over the next 24h.
4. Tick the boxes above as you go.

---

## If you ever want to re-enable the digest (future amendment)

Do NOT just re-add these env vars — the code guards will still suppress everything. The full re-enable path requires a code change:

1. Set `DIGEST_DECOMMISSIONED_OVERRIDE=true` in Replit Secrets
2. Restore the manual-trigger handler in `src/mastra/routes/callIntelligenceRoutes.ts`
3. Uncomment the Inngest `createFunction` block in `src/mastra/inngest/index.ts`

Three steps required (deliberate friction so the digest can't be turned back on accidentally).

---

## Sign-off

- [ ] Pre-flight check passed (no new digest messages after republish)
- [ ] `WEEKLY_DIGEST` removed from Replit Secrets
- [ ] `WEEKLY_DIGEST_CRON` removed (or confirmed not present)
- [ ] `WEEKLY_DIGEST_RECIPIENTS` removed
- [ ] (Optional) `SLACK_DIGEST_CHANNEL_ID` evaluated for removal
- [ ] 24-hour spam-free confirmation

Once all boxes are ticked, this checklist is complete and can be marked done.
