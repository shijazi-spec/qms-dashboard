/**
 * The post-SQL half of the conflict detector.
 *
 * The grouping query returns one row per CRMProvider Account. Domains arrive from a
 * second, small query and are attached afterwards, so merging duplicate
 * Accounts, counting deals and owners, and the keep/close call all happen
 * HERE, in plain TypeScript. That is deliberate: the LEFT JOIN LATERAL that
 * did this in SQL took the query from ~1s to 13s (measured 2026-08-25) because
 * it ran once per open deal instead of once per surviving conflict.
 *
 * The counting has to happen after the merge — merging two Accounts can turn
 * two single-owner groups into one two-owner collision, and a keep/close
 * recommendation only means anything between deals competing for the same
 * customer.
 */
import { describe, it, expect } from "vitest";
import {
  finaliseMultiActiveDealGroups,
  type MultiActiveDealGroup,
} from "../../src/utils/duplicateRadarDatabase";

let seq = 0;
const deal = (o: Partial<any> = {}): any => ({
  id: `d${++seq}`,
  name: "Deal",
  stage: "Proposal",
  owner: "Owner A",
  amount: 1000,
  layout: "ExampleOrg",
  created: "2026-01-01T00:00:00.000Z",
  last_activity: "2026-06-01T00:00:00.000Z",
  ...o,
});

const group = (o: Partial<MultiActiveDealGroup> = {}): MultiActiveDealGroup => ({
  domain: null,
  account_id: "acc-1",
  account_name: "Example Organization",
  deals: [deal(), deal({ owner: "Owner B", stage: "On Hold" })],
  ...o,
});

const run = (gs: MultiActiveDealGroup[], multiOwnerOnly = false) =>
  finaliseMultiActiveDealGroups(gs, { multiOwnerOnly });

describe("counting", () => {
  it("counts deals, owners and value off the merged deal list", () => {
    const [a] = run([group()]);
    expect(a.open_deals).toBe(2);
    expect(a.distinct_owners).toBe(2);
    expect(a.total_open_value).toBe(2000);
    expect(a.owners).toEqual(["Owner A", "Owner B"]);
  });

  it("drops a group that is left with fewer than two deals", () => {
    expect(run([group({ deals: [deal()] })])).toHaveLength(0);
  });

  it("keeps a single-owner conflict unless multiOwnerOnly is asked for", () => {
    const g = group({ deals: [deal(), deal()] }); // same owner both sides
    expect(run([g])).toHaveLength(1);
    expect(run([g], true)).toHaveLength(0);
  });
});

describe("domain merges duplicate Account records", () => {
  it("judges the deals of two Accounts on one domain together", () => {
    const merged = run([
      group({ account_id: "acc-1", account_name: "Example Organization", domain: "<REDACTED_HOST>" }),
      group({
        account_id: "acc-2",
        account_name: "Example Organization",
        domain: "<REDACTED_HOST>",
        deals: [deal({ owner: "Owner C" }), deal({ owner: "Owner D" })],
      }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].open_deals).toBe(4);
    expect(merged[0].distinct_owners).toBe(4);
    // The fuller name survives the merge — it is the one Sales will recognise.
    expect(merged[0].account_name).toBe("Gulf International Bank");
  });

  it("keeps different domains apart", () => {
    expect(
      run([group({ domain: "<REDACTED_HOST>" }), group({ account_id: "acc-2", domain: "<REDACTED_HOST>" })]),
    ).toHaveLength(2);
  });

  it("keeps domain-less Accounts apart even when the names look alike", () => {
    // Without a domain there is no evidence these are one company, and merging
    // on name alone is what produced false conflicts before.
    const out = run([
      group({ account_id: "acc-1", account_name: "Example Organization" }),
      group({ account_id: "acc-2", account_name: "Example Organization" }),
    ]);
    expect(out).toHaveLength(2);
  });

  it("does not count one deal twice when it reaches the group by two paths", () => {
    const shared = deal({ id: "same-deal" });
    const out = run([
      group({ domain: "<REDACTED_HOST>", deals: [shared, deal()] }),
      group({ account_id: "acc-2", domain: "<REDACTED_HOST>", deals: [shared, deal()] }),
    ]);
    expect(out[0].open_deals).toBe(3);
  });

  it("promotes a merge that only becomes a multi-owner collision after merging", () => {
    // Each Account on its own is one owner working two deals — housekeeping.
    // Together they are two people on one client, which is the escalation.
    const out = run(
      [
        group({ domain: "<REDACTED_HOST>", deals: [deal({ owner: "A" }), deal({ owner: "A" })] }),
        group({
          account_id: "acc-2",
          domain: "<REDACTED_HOST>",
          deals: [deal({ owner: "B" }), deal({ owner: "B" })],
        }),
      ],
      true,
    );
    expect(out).toHaveLength(1);
    expect(out[0].distinct_owners).toBe(2);
  });
});

describe("ownership beats pipeline position — through the SHIPPED code", () => {
  // keepCloseSuggestion.vitest.test.ts models the ordering; this exercises the
  // real annotateKeepClose via the exported entry point, so the rule cannot
  // drift between the model and what actually runs.

  it("keeps the rep's On Hold over the placeholder-owned New Deal", () => {
    // SBAHC / Royal Commission: owner "ExampleOrg" is the tenant's placeholder
    // on unassigned records, not a person.
    const [a] = run([
      group({
        deals: [
          deal({ id: "unowned", stage: "New Deal", owner: "ExampleOrg" }),
          deal({ id: "owned", stage: "On Hold", owner: "Mansour Alqahtani" }),
        ],
      }),
    ]);
    expect(a.deals.find((d) => d.suggestion === "keep")?.id).toBe("owned");
  });

  it("says WHY, so a keeper at an earlier stage does not look like a mistake", () => {
    const [a] = run([
      group({
        deals: [
          deal({ id: "unowned", stage: "New Deal", owner: "Unassigned" }),
          deal({ id: "owned", stage: "On Hold", owner: "Sample User" }),
        ],
      }),
    ]);
    expect(a.deals.find((d) => d.id === "owned")?.suggestion_reason).toContain("real owner");
    expect(a.deals.find((d) => d.id === "unowned")?.suggestion_reason).toContain("nobody owns");
  });

  it("leaves an ownerless deal alone once it reaches a closing stage", () => {
    const [a] = run([
      group({
        deals: [
          deal({ id: "unowned", stage: "Proposal", owner: "ExampleOrg" }),
          deal({ id: "owned", stage: "Contacted", owner: "Ali AlRajhi" }),
        ],
      }),
    ]);
    expect(a.deals.find((d) => d.suggestion === "keep")?.id).toBe("unowned");
  });
});

describe("recommendation and ordering", () => {
  it("annotates exactly one keeper per conflict", () => {
    const [a] = run([group()]);
    expect(a.deals.filter((d) => d.suggestion === "keep")).toHaveLength(1);
    expect(a.deals.filter((d) => d.suggestion === "close")).toHaveLength(1);
  });

  it("ranks the keeper across the MERGED set, not per Account", () => {
    const out = run([
      group({ domain: "<REDACTED_HOST>", deals: [deal({ stage: "Contacted" }), deal({ stage: "New Deal" })] }),
      group({
        account_id: "acc-2",
        domain: "<REDACTED_HOST>",
        deals: [deal({ stage: "Agreement Sent" }), deal({ stage: "On Hold" })],
      }),
    ]);
    const keeper = out[0].deals.find((d) => d.suggestion === "keep");
    expect(keeper?.stage).toBe("Agreement Sent");
  });

  it("puts multi-owner collisions first, then deal count, then value", () => {
    const out = run([
      group({ account_id: "a", account_name: "Example Organization", deals: [deal(), deal()] }),
      group({
        account_id: "b",
        account_name: "Example Organization",
        deals: [deal({ owner: "X" }), deal({ owner: "Y" })],
      }),
    ]);
    expect(out.map((r) => r.account_name)).toEqual(["collision", "small"]);
  });
});
