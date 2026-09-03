# SDR Pre-Qualification — 3-Point Verification Step

**Audience:** ExampleOrg SDR team
**Effective from:** [pick a rollout date, recommend coordinating with the PDPL consent rollout]
**Owner:** user@example.invalid
**Status:** Draft v1 — review with SDR ops + sales leadership before adoption
**Pairs with:** `SDR_PDPL_Consent_Script_2026_05_25.md`

---

## Why this exists

The current SDR Call Script (`SDR Call Script_AR [Updated].pdf`, v2.1) has the agent ask about the customer's email + company size only **inside the pricing-discussion branch** — not as a standard pre-qualification gate. That means:

- Leads who don't ask about pricing slip through with **no verified identity** in CRM
- Sales receives leads where the name is unconfirmed, the email is missing or personal, and the company is a free-text label rather than a verified entity
- Downstream we can't tell a real prospect from a partial entry, which inflates the pipeline and pollutes coaching metrics

The fix is a **mandatory 3-point verification step** at the SDR stage, before any substantive discovery. The SDR confirms:

1. **Lead's name** (as it should appear on a future agreement / proposal)
2. **Work email** (must be a corporate domain — not gmail/hotmail/outlook etc.)
3. **Company name** (as the legal/operating entity, not a colloquial reference)

Without all three, the lead is **not qualified** and shouldn't be passed to Sales. SDR books a follow-up to complete the verification, or politely closes the call.

---

## The three questions — Arabic (primary)

These slot in **after the PDPL consent line and the prospect agreeing to continue**, **before** the qualifying / discovery question (*"هل عندك فكرة عن ولاء بلس..."*).

Conversational delivery, not a checklist read-out. The framing is *"let me make sure I have your details right"* — service-first, not interrogative.

> قبل ما نكمّل، أبغى أتأكد من بعض التفاصيل عشان تكون عندي معلوماتك صح:
>
> 1. اسمك الكريم بالكامل، لو سمحت؟
> 2. الإيميل الخاص بالعمل عشان نرسل لك أي تفاصيل بعدين؟
> 3. اسم الشركة اللي تعمل فيها؟

**Phrasing notes:**
- *قبل ما نكمّل* — picks up the same *قبل ما...* register the script already uses
- *أبغى أتأكد* — "I'd like to confirm" — softer than *أحتاج* (I need)
- *عشان تكون عندي معلوماتك صح* — explains the WHY in human terms (so I have your details right), not in policy terms
- *الإيميل الخاص بالعمل* — specifically "work email," not just "email," so the prospect doesn't reflexively give a personal one
- *عشان نرسل لك أي تفاصيل بعدين* — gives the prospect a reason to share it (future communication), not just a data-collection exercise
- Total: ~10–12 seconds when said naturally

## The three questions — English (for English-speaking prospects)

> "Before we continue, let me make sure I have your details right:
>
> 1. Could I have your full name?
> 2. What's the best work email to reach you on for follow-up?
> 3. And the name of the company you're with?"

---

## Where it goes — mapped to the actual script

Pulling from *SDR Call Script_AR [Updated].pdf* v2.1, with the consent insert from `SDR_PDPL_Consent_Script_2026_05_25.md` already in place:

```
1. السلام عليكم ورحمة الله وبركاته،
2. معي الأستاذ/ [اسم العميل]؟
3. معك (اسم الموظف) من شركة ولاء بلس (من قسم تطوير المبيعات / الأعمال).
4. [PDPL CONSENT LINE]                    ← from the consent doc
5. [WAIT FOR AFFIRMATIVE]
6. [3-POINT VERIFICATION STEP]            ← INSERT HERE  ← this doc
7. [WAIT, CAPTURE THE 3 VALUES]
8. سؤال تمهيدي: ممكن أعرف أستاذ/ [الاسم]، هل عندك فكرة عن ولاء بلس...؟
9. ...rest of existing script unchanged...
```

So the **order** is: greeting → self-id → consent → verification → discovery. Each gate happens once, before the next stage begins.

### "مين معاي؟" branch

When the customer asks *"مين معاي؟"* and the script triggers the fuller self-introduction, the order is:

```
[FULLER SELF-INTRO ending with: ...بعد ما اطلعت على إعلاننا...]
[PDPL CONSENT LINE]
[WAIT FOR AFFIRMATIVE]
[3-POINT VERIFICATION STEP]
[WAIT, CAPTURE THE 3 VALUES]
قبل ما أشاركك التفاصيل، هل حضرتك المسؤول عن برامج الموارد البشرية...
```

The decision-maker check (*"هل حضرتك المسؤول..."*) stays where it is, AFTER the 3-point verification. Verifying identity first then checking role mirrors how a B2B sales call should flow: who → where → role → fit.

---

## What counts as "verified"

A lead is verified when **all three** are captured AND the email passes a domain check.

### 1. Name

- **Verified:** prospect provides their first + last name clearly
- **Not verified:** first name only, nickname, refuses

### 2. Work email

- **Verified:** ends with the company's domain (e.g. `user@example.invalid`), OR a domain that obviously belongs to a real business (e.g. `<REDACTED_HOST>`, `<REDACTED_HOST>`, `<REDACTED_HOST>`)
- **Not verified:** any of the following:
  - `@<REDACTED_HOST>`, `@<REDACTED_HOST>`, `@<REDACTED_HOST>`, `@<REDACTED_HOST>`, `@<REDACTED_HOST>`, `@<REDACTED_HOST>`
  - Free-tier domain (`@mail.ru`, etc.)
  - Refusal to share
  - Personal email used "because work email is internal-only"

When the prospect gives a personal email, polite re-ask:
> "تمام، بس عشان نقدر نتابع معك بشكل رسمي، نفضّل الإيميل اللي يكون من نطاق الشركة. هل عندك واحد كذا؟"
> (*"Got it, but for official follow-up we prefer the email on your company domain. Do you have one?"*)

### 3. Company name

- **Verified:** prospect names a specific company; the SDR can spell it back for confirmation
- **Not verified:** "a few different companies," "freelance / consultant for various clients," refusal

### Edge case: same-company verification

If the prospect's email domain doesn't match the company name they gave (e.g. *"شركة الصحراء"* but `@<REDACTED_HOST>`), the SDR clarifies — there's often a parent company, holding entity, or rebranding. Note both in the CRM.

---

## What to do if verification fails

This is the gate that protects pipeline quality. **Do not pass an unverified lead to Sales.**

### Partial verification (1–2 of 3 captured)

1. Acknowledge: *"تمام، فهمت."*
2. Offer a path to completion: *"خلوني أرسل لك ملخص قصير على الإيميل، وأرجع نتواصل لو في تفاصيل ناقصة؟"*
3. Log what was captured + what's missing in the CRM
4. Schedule a follow-up call ≤ 7 days
5. **Do not** proceed to the pricing / pitch portion

### Refusal across the board

1. Acknowledge politely
2. Offer alternative: *"ممكن أرسل لك التفاصيل العامة على رقم الجوال على الواتساب لو سمحت؟"*
3. End the call within 60 seconds
4. Mark the lead in CRM as `verification_refused` and DO NOT requeue automatically
5. Manager reviews refused-verification leads weekly to decide on closure or escalation

### Common objections + responses

| Prospect says | Recommended response |
|---|---|
| *"ليش تبغى كل هذي المعلومات؟"* | *"عشان أضمن إن أي معلومة أرسلھا لك تكون رسمية ومن قنواتنا الصحيحة، ومحفوظة عندي بشكل صح."* |
| *"إيميلي ما يهم، اتصلوا فيني"* | *"تمام، بس الإيميل ضروري نرسل عليه ملخص الاجتماع والعروض. تقدر تعطيني الإيميل الرسمي؟"* |
| *"رح أرسله لك بالواتساب لاحقاً"* | *"تمام، ممكن نأكد الاجتماع بعد ما يوصل الإيميل، أنسب لك؟"* |
| *"الشركة ما عندنا إيميلات شركة"* | *(rare for a SaaS prospect)* — log as a flag for sales; might be a startup or sole-prop. Still proceed only if discovery confirms a real buyer. |

---

## Logging — every call, going forward

After the call, log in the CRM (Lead record + Notes):

| Field | Values |
|---|---|
| `verified_name` | yes / no |
| `verified_work_email` | yes / no / personal-email-only |
| `verified_company` | yes / no |
| `verification_complete` | yes (all 3 yes) / partial / no |
| `email_domain_class` | `corporate` / `personal` / `government` / `unknown` |
| `verification_notes` | free text (1 line if any nuance) |

These six fields are the manual audit trail until the platform's auto-verification ships (see "Platform mapping" below).

---

## Platform mapping — what we'll build when there's data

Once the script has been live for 2+ weeks and the dataset contains real verification dialogue, the platform side is a small ship — most of the plumbing already exists.

### What the AI can extract from the Whisper transcript

For each call the analysis already runs through, we can extract:

| Field | Detection method |
|---|---|
| `verification.name_asked` | Boolean — did the SDR say "اسمك الكريم" / "your full name" / similar |
| `verification.name_captured` | Boolean — did the customer give a 2-token name |
| `verification.email_asked` | Boolean — did the SDR ask for an email |
| `verification.email_captured` | The email itself (regex: `[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}`) |
| `verification.email_domain_class` | Lookup against a corporate/personal/government domain dictionary |
| `verification.company_asked` | Boolean — did the SDR ask for the company name |
| `verification.company_captured` | The company token (or null) |
| `verification.complete` | Boolean — all three captured AND email domain is corporate/government |

The scorecard already has a `key_moments.discovery` slot that's currently underused. Verification cleanly lives inside the People dimension (the SDR's behaviour) AND the Governance dimension (data quality / lead-record integrity).

### KPIs that will land on the dashboard

- **Verification Capture Rate** — % of analyzed calls where `verification.complete = true`. New KPI card on Overview, sits next to the eventual Consent Capture Rate.
- **Verification breakdown** — three small bars (Name / Email / Company captured) so a low total reveals which specific step the SDR is skipping.
- **Email-domain mix** — pie chart: corporate / personal / government / unknown. Personal-email rate is the actionable coaching signal.

### COPC scorecard attributes

Two new attributes added under the **People** dimension (where SDR behaviour is scored):

1. *"Lead Identity Verification — Name + Email + Company"*
   PASS when `verification.complete = true`. FAIL otherwise.
2. *"Work-Email Domain Quality"*
   PASS when `email_domain_class IN (corporate, government)`. FAIL on personal. NA when no email was captured.

### Coaching triggers

Plugs into the coaching loop shipped 2026-05-25. Any agent failing either attribute on 3+ calls in 14 days → auto-generates a coaching plan in the **Coaching tab → Pending Delivery** column. Same workflow, no extra plumbing.

---

## Rollout plan

| Week | Action |
|---|---|
| W0 — Update master script | Open `SDR Call Script_AR [Updated].pdf` and add **both** the consent line and the 3-point verification step at the insertion points described in this doc and the consent doc. Save as `SDR Call Script_AR v2.2_PDPL_Verification.pdf` so the version bump captures both changes together. |
| W1 — Brief | Single 45-min team meeting covers PDPL consent + verification together (they're back-to-back in the flow). Practice both as a continuous opening. Address common objections from this doc + the consent doc. |
| W2 — Pilot | Same 1–2 agents who pilot the consent line also pilot verification. Manager reviews 5 calls per agent end of week. Track refused-verification leads in a weekly summary. |
| W3 — Full rollout | All SDRs use both. Manager spot-checks 3 random calls/agent/day for the first week. CRM lead-creation now blocks if `verification_complete != yes` (or requires manager override with reason). |
| W4 — Dashboard | Verification Capture Rate KPI + scorecard attributes + coaching triggers ship together with the matching consent dashboard piece. Single deploy. |

---

## Why pair the rollout with PDPL consent

Three reasons to brief, pilot, and ship these together:

1. **Same insertion point** in the script (between self-id and discovery). Training the team on one is training them on the other.
2. **Same platform mapping** (KPI card + scorecard attribute + coaching trigger). One deploy covers both.
3. **Same audit story** — "we ask consent, we verify identity, we log both" — is what regulators and enterprise buyers actually want to hear. Telling that story half-formed is worse than telling it complete.

---

## What this doc is NOT

- Not a CRM data-cleansing project — covers only what the SDR captures during the call. Existing dirty records require a separate sweep.
- Not a replacement for the decision-maker check (*"هل حضرتك المسؤول..."*) already in the script. That stays where it is, after verification.
- Not a hard block on the call. Verification refused = lead doesn't progress to Sales. The call itself can still end politely; the prospect isn't being interrogated.
- Not yet enforced in the platform. The dashboard piece ships in W4 once the script change has produced real data.
