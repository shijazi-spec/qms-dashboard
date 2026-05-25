# SDR Opening Script — PDPL Consent Insert

**Audience:** WalaPlus SDR team
**Effective from:** [pick a rollout date, recommend 7 days from team brief]
**Owner:** a.amashah@walaplus.com
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

Place this **immediately after** your existing greeting and self-identification, **before** asking any qualifying questions or starting the pitch.

> السلام عليكم، معك [الاسم] من شركة وَلَاء بلَس.
> هل تسمح لي بالاستمرار؟ أنوّه أن المكالمة مسجّلة لأغراض الجودة والتدريب.

**Pronunciation notes for new agents:**
- *وَلَاء بلَس* — "Walā Plus" (a slight pause after Walā)
- *هل تسمح* — softer than "هل توافق"; sounds like asking permission rather than reading legal text
- *لأغراض الجودة والتدريب* — "for quality and training purposes"

## The line — English (for English-speaking prospects)

> "Hi, this is [name] from WalaPlus.
> Before we continue — just to let you know, this call is recorded for quality and training purposes. Is that okay?"

---

## Where it goes in your existing script

```
EXISTING                                NEW
─────────────────────────────────────   ─────────────────────────────────
1. Greeting (السلام عليكم)
2. Self-introduction (name + company)
                                        3. PDPL CONSENT LINE  ← INSERT HERE
                                        4. Wait for affirmative response
4. Reason for call / value prop
5. Qualifying questions
6. Next step (book demo / send info)
7. Close
```

The whole insert adds **~6 seconds** to the opening. It does NOT replace any existing content; it sits between identification and pitch.

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

Until the QMS dashboard's automatic consent-detection feature ships, this is the manual audit trail. Once the dashboard ships, the AI will auto-detect consent from the transcript and these fields will populate automatically — but until then, keep the manual log.

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
| W1 — Brief | Team meeting (30 min). Walk through this document. Practice the line out loud as a group. Address questions. |
| W2 — Pilot | 1–2 agents adopt the line on every outbound call. Manager reviews 5 calls per agent end of week. Refine wording if needed. |
| W3 — Full rollout | All SDRs use the line. Manager spot-checks 3 random calls per agent per day for the first week. |
| W4 — Dashboard | The Call Evaluation dashboard's auto-detection feature can now be built — by this point most calls in the dataset will have the consent line, so the metric is meaningful rather than universally red. |

---

## Internal references

- [Saudi PDPL — official text (Arabic)](https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/3a73a72c-2f02-419d-8e80-b6cce0db28a3/1)
- [SDAIA implementing regulations](https://sdaia.gov.sa/en/SDAIA/about/Files/PersonalDataEnglishV2-23April2023Reviewed.pdf)
- Internal policy: WalaPlus Privacy Policy (see compliance/legal team)

---

## What this doc is NOT

- Not legal advice — review with your legal/compliance team before adoption.
- Not a full PDPL compliance program — covers recorded-call consent only. The broader programme (data retention, subject-access requests, data-processor agreements, etc.) is out of scope.
- Not enforced by the platform yet — the dashboard's auto-detection feature is parked until this script is adopted (see Week 4 above).
