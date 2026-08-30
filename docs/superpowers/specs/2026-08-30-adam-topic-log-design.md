# Adam Topic Log — Self-Evolving Options Menu — Design Spec

**Date:** 2026-08-30
**Author:** Sarah Hijazi (GRQ) + Claude
**Status:** Approved shape — pending spec review

## 1. Goal

Make Adam's numbered options menu **evolve from what people actually ask**, across the whole team, instead of being a static list that only changes when the prompt is edited.

Today the menu is five hardcoded lines in the prompt, and Adam's only "learning" is per-person working memory. This adds a shared, ranked topic log: the menu leads with what this team asks most, and genuinely new themes surface for promotion.

## 2. Approved decisions

- **New topics: surface, then promote.** Unmatched questions contribute normalized KEYWORDS only. Recurring unknown themes are surfaced as "people keep asking about X" for a human to promote into a named option. Nothing auto-invents a label in front of a manager.
- **Storage: topic + keywords only.** NEVER store the raw question. Questions routinely contain client company names and contact details (the 56-company lists), so the log keeps: topic key, surface, asker, timestamp, and for unmatched a few normalized keywords with emails / phones / long digit strings / URLs stripped.

## 3. Canonical topics

Seeded set, each with match keywords (EN + light AR where obvious):

| key | label (menu text) | sample keywords |
|---|---|---|
| `data_cleanup` | Data cleanup — duplicates merged, what is still open | duplicate, duplicates, cleanup, merge, merged, dedupe, تكرار |
| `cs_lifecycle` | CS Lifecycle — client phases, renewals, violations | cs lifecycle, renewal, churn, onboarding, adoption, phase, customer success |
| `deals` | Deals — stage aging, document compliance | deal, deals, stage, aging, proposal, agreement, compliance, documents |
| `kpis` | KPIs — the GRQ scorecard and any red KPIs | kpi, kpis, scorecard, target, red kpi, performance |
| `open_actions` | Open actions — CAPAs and owner accountability | capa, action, actions, accountability, owner, overdue |
| `preflight` | Preflight — vetting a company before creating it | preflight, existing client, already a client, vet, import, lead check |
| `documents` | Documents — SOPs, policies, document control | sop, policy, policies, document control, governance document |
| `sync_status` | CRM sync — freshness and scan status | sync, scan, refresh, last sync, up to date |

Kept in ONE exported constant so the classifier, the ranker and the menu all read the same source. Adding a topic = adding an entry here (that IS the promotion step from §2).

## 4. Classifier (pure)

`classifyQuestionTopic(text): { topic: string | null; keywords: string[] }` in `src/utils/adamTopicLog.ts`:
- Lowercase; strip emails, phone-like digit runs (>= 7 digits), URLs, and non-word punctuation.
- First topic whose keyword appears as a whole word/phrase wins (canonical order above). Deterministic — no LLM call, no latency added to a chat turn.
- When nothing matches, return `topic: null` plus up to 5 normalized keywords: tokens with stopwords removed, length >= 4, no digits — so a recurring unknown theme is visible without keeping the sentence.
- A question shorter than 3 tokens (e.g. "status?") classifies as `null` with NO keywords — too thin to learn from and exactly the vague case the menu exists for.

## 5. Storage

```sql
CREATE TABLE IF NOT EXISTS adam_topic_log (
  id         SERIAL PRIMARY KEY,
  topic_key  VARCHAR(40),              -- NULL when unmatched
  keywords   TEXT[] NOT NULL DEFAULT '{}',  -- only populated when topic_key IS NULL
  surface    VARCHAR(16) NOT NULL,     -- 'web' | 'slack'
  asked_by   VARCHAR(200),             -- asker email (same norm as other audit tables)
  asked_at   TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_adam_topic_log_asked_at ON adam_topic_log(asked_at DESC);
CREATE INDEX IF NOT EXISTS idx_adam_topic_log_topic ON adam_topic_log(topic_key);
```

**Retention:** this is AI-usage data derived from user questions, so it lives under the platform's existing AI-metrics retention regime (`AI_METRICS_RETENTION_DAYS`, audited, bounded, lockable) rather than growing forever — the prune path deletes `adam_topic_log` rows older than the configured window alongside the other AI metrics tables. Schema-parity: the CREATE TABLE above is canonical; any later column must be added in BOTH the CREATE and an idempotent ALTER.

**Never stored:** the raw question, message ids, or any client name/phone/email.

## 6. Recording

`recordQuestionTopic(text, { surface, askedBy })` — fire-and-forget (never throws, never blocks a reply; a logging failure must not break a chat turn). Called from BOTH entry points so the ranking reflects the whole team:
- Web: the consultant chat handler in `src/mastra/routes/consultantRoutes.ts`.
- Slack: `src/triggers/grqAssistantSlackChat.ts`, before the agent call.

## 7. Ranking + the live menu

`getTopicMenu(limit = 5)` in the same util:
- Counts rows per `topic_key` over the last 90 days.
- Returns ALL canonical topics ordered by count desc, then canonical order for ties — so the menu is complete on day one (zero-count topics still appear) and simply re-orders as usage accumulates.
- Also returns `emergingTerms`: the top unmatched keywords over the window with a count >= 3, so recurring new themes surface for promotion.

**Tool** `topic-menu` (read-only, registered on the agent) returns `{ options: [{ key, label, asked }], emergingTerms }`.

**Prompt change:** the VAGUE QUESTIONS section currently hardcodes the five options. It changes to: call `topicMenuTool` and offer the options it returns, in the order returned, numbered. If the tool fails, fall back to the written default list (which stays in the prompt as the safety net). Adam never shows `emergingTerms` to a manager — they are a signal for Sarah/Quality, surfaced only when someone asks what people have been asking about.

## 8. Non-goals
- No auto-invented menu labels (explicitly rejected in §2).
- No LLM classification pass — keyword matching only, so no added latency or cost per message.
- No per-person menus in this phase; ranking is team-wide. (Adam's existing working memory already personalises.)
- No dashboard UI in this phase; `emergingTerms` reaches humans through the tool.

## 9. Testing
- Pure `classifyQuestionTopic`: known topic matches; PII stripped (an email / a +966 number / a URL never appears in keywords); unmatched returns keywords; a 2-token question returns null with no keywords; canonical-order precedence when two keywords appear.
- Pure ranking shaper: all canonical topics always present; ordering by count then canonical order; `emergingTerms` respects the >= 3 threshold.
- Mocked-pool test that `recordQuestionTopic` never throws when the query rejects, and that the INSERT carries no raw text column.
- `tsc --noEmit`, `tsc -p tsconfig.tests.json`, `check:schema-parity` clean. Backtick-line count in `qmsConsultantAgent.ts` unchanged (11).

## 10. Deployment
Commit only touched files; push `origin/QMS`; user Pulls -> Republishes. The table is created in the idempotent table-init path on boot — no manual migration, no DROP.

---

## REVISION 1 (Sarah, 2026-08-30) — sections, not keywords

Review of Task 1 surfaced that free-text keywords could still persist a client's company name ("Acme Trading Ltd wants a brochure" -> keywords acme, trading), contradicting the "never store any client name" guarantee in §5. Sarah's direction: **"make the questions general as sections that we have inside the platform."**

This SUPERSEDES §3, §4 (keyword extraction), §5 (keywords column) and §7 (emergingTerms):

- Every question is classified into one of the platform's REAL sections (taken from the sidebar nav) — Duplicates Radar, Quality Reports, KPIs, Internal Audits, CAPA / Audit Reports, Compliance, Risk, Documents & SOPs, Call Evaluation, Handoff Tracker, Vendors, Management Review, Fraud, Team Performance, AI Approvals — plus the radar sub-topics people actually ask about by name (CS Lifecycle, Deal Compliance, Preflight).
- **NO free text is stored at all.** The `keywords` column is dropped from the design. A question that matches nothing is logged as `section_key = NULL` — a COUNT only, never any words from the question.
- `emergingTerms` is replaced by `unclassified`: a count of questions that matched no section. A rising count is the signal to extend a section's keyword list (a human edit), which is the same surface-then-promote discipline with zero text retained.
- The menu therefore ranks the platform's own sections by what the team asks about, and each option carries its `href` so Adam can link straight to the page.

Net effect: strictly more private (no question-derived text in the database at any point) and better aligned to how the team thinks about the platform.
