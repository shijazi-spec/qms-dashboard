# Quality ↔ GRC Handoff Tracker — Design

**Date:** 2026-07-20 · **Approved by:** Sarah Hijazi

## Problem

Quality (Sarah) and GRC (Maram) hand work to each other with no shared surface, so
nothing is tracked and the **Quality ↔ GRC Handoff Effectiveness** KPI (GRQ-KPI-02)
has to be typed in by hand. The Excel note on that KPI reads *"will be done
automatically via platform"*.

## Decision

Build a shared task tracker that **IS** the handoff mechanism — every task assigned
between Quality and GRC is a handoff — so the KPI calculates itself from real usage.

`handoff_events` is NOT reused: it is a rule-driven automation log (rule_id,
source/target module, error_message) with no title, assignee or due date. Mixing
human tasks into it would muddy both. A purpose-built table is cleaner.

## Data model — `handoff_tasks`

| column | purpose |
|---|---|
| `title`, `description` | what is being handed off |
| `created_by`, `assigned_to` | emails; sender and receiver |
| `due_date` | drives the "on time" half of the KPI |
| `status` | `sent` / `accepted` / `done` / `rejected` |
| `accepted_at`, `completed_at`, `rejected_at` | lifecycle timestamps |
| `reject_reason` | why it bounced |
| `rework_count` | increments each time a rejected task is re-sent |

## Lifecycle

```
Sent ──accept──> Accepted ──done──> Done
  └──reject(reason)──> Rejected ──re-send──> Sent (rework_count + 1)
```

## KPI wiring — GRQ-KPI-02 flips manual → auto

- **Denominator** = tasks whose `due_date` falls in the period ("handoffs due")
- **Numerator** = `status = 'done'` AND `completed_at <= due_date` AND `rework_count = 0`

This makes the KPI's own wording literally true: *on time* (due date), *accepted*
(lifecycle), *without rework* (counter). An overdue-but-still-open task counts
against the score automatically instead of hiding.

Returns `dataAvailable: false` when nothing is due in the period — never a fake 0.

## Emails (existing Resend integration)

| Trigger | Recipient |
|---|---|
| Assigned | assignee — title, description, due date, link |
| Rejected | sender — with reason |
| Done | sender — closes the loop |
| Overdue | assignee + sender — daily scheduled check |

Email failure must never block the task write (send is best-effort, logged).

## Access

Quality ↔ GRC only: `quality_manager`, `grc_manager`, plus `admin` /
`head_of_operations_quality`. Enforced in the handler AND in
`ROUTE_PERMISSION_MAP` (deny-by-default).

## UI

`/handoff-tracker` under Team Mgmt. Two lists — **Assigned to me** / **I assigned** —
an add form (title, description, due date, assignee), and per-task Accept / Reject
(reason) / Done actions. Overdue rows flagged.

## Verification

`tsc --noEmit` · `check-dashboard-html-js` · `check-schema-parity` (new table) ·
RBAC deny-by-default test · numeric check of the KPI math across on-time / late /
rework / still-open cases.

## Out of scope

Other GRQ members (AlHanouf, Ali Fahad), attachments, comment threads, and
org-wide assignment. Deliberately Quality↔GRC only so the KPI cannot be polluted.
