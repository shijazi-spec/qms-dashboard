import { describe, it, expect } from "vitest";
import { shouldSkipSeed } from "../../src/utils/seeds/obligationSeedTypes";

describe("shouldSkipSeed", () => {
  it("runs a fill seed even when the framework already has more rows than the fill", () => {
    // 18 PDPL rows already exist; the fill defines 7 NEW codes, none present.
    expect(shouldSkipSeed(0, 7)).toBe(false);
  });
  it("skips when every code in this seed already exists", () => {
    expect(shouldSkipSeed(7, 7)).toBe(true);
  });
  it("runs on a fresh database", () => {
    expect(shouldSkipSeed(0, 18)).toBe(false);
  });
  it("runs when a seed is only partially applied", () => {
    expect(shouldSkipSeed(12, 18)).toBe(false);
  });
});
