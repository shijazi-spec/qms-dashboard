import { contactNeedsAccount, dealNeedsContact, scoreLinkConfidence, pickAccountForContact, pickContactForDeal } from "./recordLinkHints";

let pass = 0, fail = 0;
const ok = (cond: boolean, name: string) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name); } };

ok(contactNeedsAccount({ Account_Name: null }) === true, "contact with null Account_Name needs account");
ok(contactNeedsAccount({ Account_Name: { id: "1", name: "Example Organization" } }) === false, "contact with an account does not");
ok(contactNeedsAccount({ Account_Name: { name: "-" } }) === true, "contact with placeholder account needs account");

ok(dealNeedsContact({ Contact_Name: null }) === true, "deal with null Contact_Name needs contact");
ok(dealNeedsContact({ Contact_Name: { id: "9", name: "Sample User" } }) === false, "deal with a contact does not");

ok(scoreLinkConfidence({ agreeing: 0, explicitDomain: false, relatedRecords: 0 }) === 40, "base 40");
ok(scoreLinkConfidence({ agreeing: 2, explicitDomain: true, relatedRecords: 3 }) === 100, "strong evidence caps at 100");
ok(scoreLinkConfidence({ agreeing: 1, explicitDomain: false, relatedRecords: 0 }) === 50, "one agreeing +10");

ok(pickAccountForContact("<REDACTED_HOST>", [{ id: "A1", domain: "<REDACTED_HOST>", name: "Example Organization" }])?.id === "A1", "contact->account by domain");
ok(pickAccountForContact("<REDACTED_HOST>", []) === null, "no account candidate -> null");
ok(pickContactForDeal("<REDACTED_HOST>", [{ id: "C1", domain: "<REDACTED_HOST>", name: "Sample User" }])?.id === "C1", "deal->contact single under account");
ok(pickContactForDeal("<REDACTED_HOST>", [{ id: "C1", domain: "<REDACTED_HOST>" }, { id: "C2", domain: "<REDACTED_HOST>" }]) === null, "deal->contact ambiguous -> null");
ok(pickContactForDeal("<REDACTED_HOST>", [{ id: "C1", domain: "<REDACTED_HOST>" }, { id: "C2", domain: "<REDACTED_HOST>" }]) === null, "deal->contact MULTIPLE same-domain -> null (never arbitrary auto-write)");
ok(pickContactForDeal("<REDACTED_HOST>", [{ id: "C1", domain: "<REDACTED_HOST>" }, { id: "C2", domain: "<REDACTED_HOST>" }])?.id === "C1", "deal->contact UNIQUE domain match among several -> that one");

console.log(fail === 0 ? "recordLinkHints ok" : ("FAIL " + fail));
if (fail > 0) process.exit(1);
