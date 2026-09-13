import { describe, it, expect } from "vitest";
import {
  readContactAccountLink,
  classifyContactAccountLink,
} from "../../src/utils/contactAccountLinkGuard";

const TARGET = { zohoId: "5146753000192834059", name: "ميتكس" };

describe("readContactAccountLink", () => {
  it("reads the normal Zoho lookup shape", () => {
    expect(readContactAccountLink({ id: "123", name: "Acme" })).toEqual({
      id: "123",
      name: "Acme",
    });
  });

  it("reads an older row that stored the lookup as a bare name", () => {
    expect(readContactAccountLink("Acme")).toEqual({ id: null, name: "Acme" });
  });

  it("treats missing, null and blank as no link", () => {
    expect(readContactAccountLink(undefined)).toEqual({ id: null, name: null });
    expect(readContactAccountLink(null)).toEqual({ id: null, name: null });
    expect(readContactAccountLink("   ")).toEqual({ id: null, name: null });
    expect(readContactAccountLink({ id: "", name: "" })).toEqual({ id: null, name: null });
  });
});

describe("classifyContactAccountLink", () => {
  it("links a contact that has no account — the only case the bulk job may write", () => {
    expect(classifyContactAccountLink(null, TARGET)).toBe("link");
    expect(classifyContactAccountLink(undefined, TARGET)).toBe("link");
    expect(classifyContactAccountLink({}, TARGET)).toBe("link");
  });

  it("leaves a contact already pointing at the target alone", () => {
    expect(
      classifyContactAccountLink({ id: TARGET.zohoId, name: TARGET.name }, TARGET),
    ).toBe("already_linked");
  });

  it("never overwrites a contact pointing at a different account", () => {
    // The live case that prompted the guard: مشاعل السبيعي sits under
    // مركز علاج اماثل الطبي, and the cluster wanted to move her to ميتكس.
    expect(
      classifyContactAccountLink(
        { id: "5146753000111111111", name: "مركز علاج اماثل الطبي" },
        TARGET,
      ),
    ).toBe("mismatch");
  });

  it("compares by id even when the names happen to agree", () => {
    expect(
      classifyContactAccountLink({ id: "5146753000999999999", name: TARGET.name }, TARGET),
    ).toBe("mismatch");
  });

  it("falls back to the name only when the record carries no id", () => {
    expect(classifyContactAccountLink({ name: "  ميتكس " }, TARGET)).toBe("already_linked");
    expect(classifyContactAccountLink("Acme  Corp", { zohoId: "1", name: "acme corp" })).toBe(
      "already_linked",
    );
    expect(classifyContactAccountLink("Another Co", TARGET)).toBe("mismatch");
  });

  it("does not call a name-only row linked when the target has no name", () => {
    expect(classifyContactAccountLink("Acme", { zohoId: "1", name: "" })).toBe("mismatch");
  });
});
