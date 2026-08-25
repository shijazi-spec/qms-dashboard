/**
 * Which of two competing open deals should stay, and which should close.
 *
 * Sarah asked for a recommendation alongside the created / last-activity dates
 * so the flag to Sales says what to DO, not just what is wrong. This is advice
 * only — nothing is written to Zoho.
 *
 * Order of preference, each tie broken by the next:
 *   1. furthest along the pipeline
 *   2. most recent activity
 *   3. has a value recorded
 *   4. oldest created (the original)
 *
 * The ranking deliberately puts STALLED stages below early-but-moving ones.
 * On Hold has more history than Contacted, but keeping the dormant record and
 * closing the live conversation is the wrong way round — and that is the
 * mistake a naive "furthest along" ordering would make.
 */
import { describe, it, expect } from "vitest";

const RANK: Record<string, number> = {
  "agreement sent": 70,
  proposal: 60,
  meeting: 50,
  meetings: 50,
  "follow up": 40,
  contacted: 30,
  "in progress": 30,
  "new deal": 20,
  "not attend meeting": 15,
  "on hold": 10,
  hold: 10,
  unaccounted: 5,
  "old data": 1,
};
const DEFAULT_RANK = 25;
const rankOf = (s: string) => RANK[(s || "").trim().toLowerCase()] ?? DEFAULT_RANK;

type D = {
  stage: string;
  owner?: string;
  amount?: number;
  created?: string;
  activity?: string;
};

const UNOWNED = new Set(["", "unassigned", "walaplus", "wala plus"]);
const PROTECTED_UNOWNED_RANK = 60;
/** 1 = demoted. A deal nobody owns cannot carry the account forward. */
const demote = (d: D) =>
  UNOWNED.has(String(d.owner ?? "x").trim().toLowerCase()) &&
  rankOf(d.stage) < PROTECTED_UNOWNED_RANK
    ? 1
    : 0;

/** Mirrors annotateKeepClose's ordering. */
function keeper(deals: D[]): number {
  const ms = (v?: string) => (v ? new Date(v).getTime() || 0 : 0);
  return [...deals.map((d, i) => ({ i, d }))].sort(
    (a, b) =>
      demote(a.d) - demote(b.d) ||
      rankOf(b.d.stage) - rankOf(a.d.stage) ||
      ms(b.d.activity) - ms(a.d.activity) ||
      ((b.d.amount || 0) > 0 ? 1 : 0) - ((a.d.amount || 0) > 0 ? 1 : 0) ||
      (ms(a.d.created) || Number.MAX_SAFE_INTEGER) - (ms(b.d.created) || Number.MAX_SAFE_INTEGER),
  )[0].i;
}

describe("pipeline position decides first", () => {
  it("keeps Proposal over Contacted", () => {
    expect(keeper([{ stage: "Contacted" }, { stage: "Proposal" }])).toBe(1);
  });

  it("keeps Agreement Sent over everything else open", () => {
    expect(
      keeper([{ stage: "Proposal" }, { stage: "Meeting" }, { stage: "Agreement Sent" }]),
    ).toBe(2);
  });

  it("gives an unknown stage a middling rank, not zero", () => {
    // A stage this list has never seen must not automatically lose to New Deal.
    expect(keeper([{ stage: "New Deal" }, { stage: "Some Future Stage" }])).toBe(1);
    expect(keeper([{ stage: "Proposal" }, { stage: "Some Future Stage" }])).toBe(0);
  });
});

describe("stalled stages rank below early-but-moving ones", () => {
  it("keeps Contacted over On Hold", () => {
    // The Mayar Foods shape: New Deal vs On Hold. Closing the moving deal in
    // favour of a dormant one is exactly the wrong advice.
    expect(keeper([{ stage: "On Hold" }, { stage: "Contacted" }])).toBe(1);
  });

  it("keeps New Deal over On Hold", () => {
    expect(keeper([{ stage: "On Hold" }, { stage: "New Deal" }])).toBe(1);
  });

  it("treats Not Attend Meeting as a setback, below Contacted", () => {
    expect(keeper([{ stage: "Not Attend Meeting" }, { stage: "Contacted" }])).toBe(1);
  });

  it("still keeps On Hold when it is the only alternative to Unaccounted", () => {
    expect(keeper([{ stage: "Unaccounted" }, { stage: "On Hold" }])).toBe(1);
  });

  it("never keeps an Old Data record over a live one", () => {
    // The High Source row: "Old Data" is a parking label, not a pipeline
    // position. On the default rank it scored 25, beat New Deal (20) and the
    // tab recommended keeping the dead record. It must lose to every live
    // stage, including the weakest.
    for (const live of ["New Deal", "Contacted", "On Hold", "Unaccounted"]) {
      expect(keeper([{ stage: "Old Data" }, { stage: live }])).toBe(1);
    }
  });
});

describe("ties break on activity, then value, then age", () => {
  it("prefers the more recently active deal at the same stage", () => {
    expect(
      keeper([
        { stage: "Proposal", activity: "2026-01-10" },
        { stage: "Proposal", activity: "2026-08-01" },
      ]),
    ).toBe(1);
  });

  it("prefers the costed deal when stage and activity match", () => {
    expect(
      keeper([
        { stage: "Proposal", activity: "2026-08-01", amount: 0 },
        { stage: "Proposal", activity: "2026-08-01", amount: 161400 },
      ]),
    ).toBe(1);
  });

  it("falls back to the original when nothing else separates them", () => {
    // The Aseer Development Authority shape: two Contacted deals, same owner,
    // one day apart.
    expect(
      keeper([
        { stage: "Contacted", created: "2026-04-22" },
        { stage: "Contacted", created: "2026-04-21" },
      ]),
    ).toBe(1);
  });

  it("does not let a missing created date win the tie-break", () => {
    // A null created must sort last, not first.
    expect(
      keeper([{ stage: "Contacted" }, { stage: "Contacted", created: "2025-01-01" }]),
    ).toBe(1);
  });
});

describe("a deal nobody owns cannot be the keeper", () => {
  // Sarah 2026-08-26. Five conflict deals are owned by "WalaPlus" — the
  // tenant's placeholder owner on imported/unassigned records, not a person.
  // Ownership is checked BEFORE pipeline position: there is nobody to work an
  // ownerless deal, so it must not win over one a rep is actually holding.

  it("keeps the owned On Hold over the ownerless New Deal", () => {
    // The SBAHC and Royal Commission rows exactly. Under stage-first ordering
    // New Deal (20) beat On Hold (10) and the tab recommended keeping a deal
    // nobody owns.
    expect(
      keeper([
        { stage: "New Deal", owner: "WalaPlus" },
        { stage: "On Hold", owner: "Mansour Alqahtani" },
      ]),
    ).toBe(1);
  });

  it("treats the literal 'Unassigned' fallback the same way", () => {
    expect(
      keeper([
        { stage: "Contacted", owner: "Unassigned" },
        { stage: "On Hold", owner: "Khowla Saeed" },
      ]),
    ).toBe(1);
  });

  it("treats a blank owner the same way", () => {
    expect(
      keeper([{ stage: "Meeting", owner: "" }, { stage: "New Deal", owner: "Rayan Saleh" }]),
    ).toBe(1);
  });

  it("does NOT demote an ownerless deal that is already at a closing stage", () => {
    // Closing live commercial progress because of a blank field would be
    // destructive. The fix for these is to assign an owner, not to close them.
    expect(
      keeper([
        { stage: "Proposal", owner: "WalaPlus" },
        { stage: "New Deal", owner: "Ali AlRajhi" },
      ]),
    ).toBe(0);
    expect(
      keeper([
        { stage: "Agreement Sent", owner: "WalaPlus" },
        { stage: "Contacted", owner: "Ali AlRajhi" },
      ]),
    ).toBe(0);
  });

  it("falls back to the normal rules when NEITHER deal has an owner", () => {
    // The وكالة جهة حكومية / نادي ضباط shape: both sides ownerless. The rule
    // is inert and pipeline position decides as before.
    expect(
      keeper([
        { stage: "Unaccounted", owner: "WalaPlus" },
        { stage: "Contacted", owner: "Unassigned" },
      ]),
    ).toBe(1);
  });

  it("still ranks normally between two owned deals", () => {
    expect(
      keeper([
        { stage: "On Hold", owner: "A" },
        { stage: "Proposal", owner: "B" },
      ]),
    ).toBe(1);
  });

  it("does not let a big amount rescue an ownerless deal", () => {
    // oracle: the ownerless Unaccounted deal carried SAR 89,800.
    expect(
      keeper([
        { stage: "Unaccounted", owner: "WalaPlus", amount: 89800 },
        { stage: "On Hold", owner: "Yahya Alshehri", amount: 0 },
      ]),
    ).toBe(1);
  });
});

describe("real conflicts from the CRM", () => {
  it("Stc — keeps the Proposal, closes the On Hold", () => {
    const deals: D[] = [
      { stage: "Proposal", amount: 1810000, created: "2026-06-09" },
      { stage: "On Hold", amount: 0, created: "2025-02-04" },
    ];
    expect(keeper(deals)).toBe(0);
  });

  it("Center3 — keeps the Meeting over the Contacted", () => {
    expect(
      keeper([
        { stage: "Contacted", created: "2026-05-10" },
        { stage: "Meeting", amount: 75920, created: "2025-03-27" },
      ]),
    ).toBe(1);
  });

  it("Lendo — two Proposals, keeps the more recent activity", () => {
    expect(
      keeper([
        { stage: "Proposal", amount: 31878, activity: "2026-07-14" },
        { stage: "Proposal", amount: 0, activity: "2023-06-01" },
      ]),
    ).toBe(0);
  });
});
