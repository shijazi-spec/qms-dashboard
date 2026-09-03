# SDR Opening Script — PDPL Consent Insert

**Audience:** ExampleOrg SDR team
**Effective from:** [pick a rollout date, recommend 7 days from team brief]
**Owner:** <REDACTED_EMAIL>
**Status:** Draft v1 — review with legal/compliance before adoption

---

## Why this exists

Saudi Arabia's **Personal Data Protection Law (PDPL)** — enforced by SDAIA since 14 September 2024 — requires that when you process a person's personal data (including their voice on a recorded call), you must have a **lawful basis**. For outbound SDR calls to prospects who haven't already signed an agreement with you, the cleanest lawful basis is the prospect's **freely-given, informed, specific, documented consent**.

Three things must be true on every recorded call:
1. The prospect was **told** the call is being recorded
2. The prospect was **told why** (purpose)
3. The prospect **agreed** before any substantive conversation continues

Without all three, you don't have a lawful basis to keep the recording. The recording becomes a liability instead of an asset.

This document is the minimal-friction insert that closes that gap without making your opening line feel like a legal warning.

---

## The line — Arabic (primary)

Match the warm, conversational register of your existing script (the
one you sent: *SDR Call Script_AR [Updated].pdf*). Two short sentences.
Goes between self-identification and the qualifying question — does
not replace anything in your current flow.

> قبل ما نبدأ أستاذ/ [اسم العميل]، أنوّه أن المكالمة مسجّلة لأغراض الجودة والتدريب فقط.
> هل تسمح لي بالاستمرار؟

**Why this wording (vs. the more formal alternatives):**
- *قبل ما نبدأ* — picks up the same colloquial register as the existing *"قبل ما أشاركك التفاصيل"* line later in your script. Doesn't sound like a legal disclaimer.
- *أستاذ/ [اسم العميل]* — keeps the respectful address you already use throughout.
- *أنوّه* — softer than *أعلمك* / *أبلغك*; means "to note" or "to remind."
- *لأغراض الجودة والتدريب فقط* — the *فقط* matters; it explicitly limits the purpose, which is a PDPL "specific" requirement.
- *هل تسمح لي بالاستمرار* — asking permission to continue, not asking for "consent." Sounds human, fully PDPL-valid.

**Pronunciation notes:**
- *وَلَاء بلَس* — "Walā Plus" (a slight pause after Walā) — this line itself stays as you say it today; no change.
- The whole insert is one breath, ~5–6 seconds.

## The line — English (for English-speaking prospects)

> "Before we get started [Mr./Ms. <name>] — just so you know, this call is being recorded for quality and training purposes only. Is that okay to continue?"

---

## Exactly where it goes in your script — mapped to your current PDF

Pulling from *SDR Call Script_AR [Updated].pdf* (the script you shared):

```
السلام عليكم ورحمة الله وبركاته،
معي الأستاذ/ [اسم العميل]؟
معك (اسم الموظف) من شركة ولاء بلس (من قسم تطوير المبيعات / الأعمال).
       │
       ▼  ← INSERT THE CONSENT LINE HERE
قبل ما نبدأ أستاذ/ [اسم العميل]، أنوّه أن المكالمة مسجّلة لأغراض الجودة والتدريب فقط.
هل تسمح لي بالاستمرار؟
       │
       ▼  ← WAIT FOR AFFIRMATIVE
سؤال تمهيدي:
ممكن أعرف أستاذ/ [الاسم]، هل عندك فكرة عن ولاء بلس والخدمات التي نقدمها؟
...rest of existing script unchanged...
```

### Second insertion point — the "مين معاي؟" branch

When the customer asks *"مين معاي؟"* the script triggers the fuller
self-introduction ending with *"...بعد ما اطلعت على إعلاننا..."*.
The consent line slots in **after that fuller introduction**, before
*"قبل ما أشاركك التفاصيل، هل حضرتك المسؤول..."*:

```
أنا [الاسم] من شركة ولاء بلس... وصلنا طلب اهتمامك ببرامج ولاء بلس...
بعد ما اطلعت على إعلاننا عبر LinkedIn/IdentityProvider/Webinar.
       │
       ▼  ← INSERT THE CONSENT LINE HERE TOO
قبل ما نبدأ، أنوّه أن المكالمة مسجّلة لأغراض الجودة والتدريب فقط.
هل تسمح لي بالاستمرار؟
       │
       ▼  ← WAIT FOR AFFIRMATIVE
قبل ما أشاركك التفاصيل، هل حضرتك المسؤول عن برامج الموارد البشرية...
```

The rule is simple: **the consent line ALWAYS goes between the agent's self-identification and ANY qualifying / discovery question.** No matter which branch of the script the call enters, that's the placement.

The whole insert adds **~5–6 seconds** to the opening. It does NOT replace any existing content from the agreed-with-SDR-team script.

---

## What counts as "agreed"

Acceptable affirmative responses:
- نعم / أيوه / تفضّل / تكرم / ماشي / تمام / أكيد
- Yes / sure / go ahead / okay / no problem

Treat ambiguous responses as **not consented**:
- "همم"
- Silence > 3 seconds
- "ليش؟" / "Why?" → answer the question, then re-ask consent

---

## What to do if the prospect says NO

This is the part that matters most for PDPL defence. **Do not continue the substantive call.**

1. Acknowledge: *"تمام، أحترم وقتك. ممكن أعيد التواصل بطريقة أخرى لو حبيت؟"*
   (*"No problem, I respect your time. Would another channel work better?"*)
2. Offer alternative: WhatsApp, email, or a callback at their preferred time **on a non-recorded line**
3. End the call within 30 seconds of refusal
4. **Log the refusal in the CRM** — see "Logging" below

**Do not:**
- Continue with the pitch hoping they'll change their mind
- Argue or justify why recording is necessary
- Lecture about the PDPL — keep it human, not legal

---

## Logging — every call, going forward

After the call, log in the CRM Notes section:

| Field | Possible values |
|---|---|
| Consent disclosed | yes / no |
| Consent obtained | yes / no / unclear |
| If no, alternative offered | yes / no |
| Notes | free text (1 line) |

Until the ExampleOrg's automatic consent-detection feature ships, this is the manual audit trail. Once the dashboard ships, the AI will auto-detect consent from the transcript and these fields will populate automatically — but until then, keep the manual log.

---

## Common objections and how to respond

| Prospect says | Recommended response |
|---|---|
| "ليش مسجلة؟" (Why recorded?) | "لتحسين جودة الخدمة فقط، وما تنشَر لأي طرف خارجي." (Just to improve service quality, and it's not shared externally.) |
| "ما أحب التسجيل" (I don't want it recorded) | "تمام، أحترم وقتك. أرسل لك التفاصيل على الواتساب لو ناسبك؟" (No problem — would WhatsApp be okay instead?) |
| "هل ممكن تحذفونها بعدين؟" (Can you delete it later?) | "أكيد، اطلب فقط وأقدر أحوّل الطلب لقسم البيانات عندنا." (Yes, just ask and I'll forward the request to our data team.) |
| "هذا قانوني؟" (Is this legal?) | "نعم، نلتزم بنظام حماية البيانات الشخصية السعودي وعندنا سياسة خصوصية معتمدة." (Yes, we comply with the Saudi PDPL and have an approved privacy policy.) |

---

## Rollout plan

| Week | Action |
|---|---|
| W0 — Update master script | Open `SDR Call Script_AR [Updated].pdf` (currently in `G:\My Drive\Quality Governance Documents\#SDR Section\SDR Governance Documents\SDR Version #2.1\2. SDR Supporting Documents & Appendices\`) and add the consent line at the two insertion points mapped above. Save as `SDR Call Script_AR v2.2_PDPL.pdf` so the version bump is visible to the team. |
| W1 — Brief | Team meeting (30 min). Walk through this document + the updated PDF. Practice both insertion points out loud as a group. Address questions and objection-handling responses (see table below). |
| W2 — Pilot | 1–2 agents adopt the line on every outbound call. Manager reviews 5 calls per agent end of week. Refine wording if needed (track issues here as v2 footnotes). |
| W3 — Full rollout | All SDRs use the line. Manager spot-checks 3 random calls per agent per day for the first week. Update the QMS to flag any call missing the disclosure (manual review for now). |
| W4 — Dashboard | The Call Evaluation dashboard's auto-detection feature can now be built — by this point most calls in the dataset will have the consent line, so the metric is meaningful rather than universally red. Wires the existing `key_moments.consent.detected` field (Whisper already populates it) into: a Consent Capture Rate KPI on Overview, a Governance attribute on the COPC scorecard, and a coaching trigger for the agents who skip it 3+ times in 14 days. |

---

## Internal references

- [Saudi PDPL — official text (Arabic)](<REDACTED_URL>
- [SDAIA implementing regulations](<REDACTED_URL>
- Internal policy: ExampleOrg Privacy Policy (see compliance/legal team)

---

## What this doc is NOT

- Not legal advice — review with your legal/compliance team before adoption.
- Not a full PDPL compliance program — covers recorded-call consent only. The broader programme (data retention, subject-access requests, data-processor agreements, etc.) is out of scope.
- Not enforced by the platform yet — the dashboard's auto-detection feature is parked until this script is adopted (see Week 4 above).
