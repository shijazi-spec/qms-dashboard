import { contactNeedsAccount, dealNeedsContact, scoreLinkConfidence } from "./recordLinkHints";

let pass = 0, fail = 0;
const ok = (cond: boolean, name: string) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name); } };

ok(contactNeedsAccount({ Account_Name: null }) === true, "contact with null Account_Name needs account");
ok(contactNeedsAccount({ Account_Name: { id: "1", name: "Acme" } }) === false, "contact with an account does not");
ok(contactNeedsAccount({ Account_Name: { name: "-" } }) === true, "contact with placeholder account needs account");

ok(dealNeedsContact({ Contact_Name: null }) === true, "deal with null Contact_Name needs contact");
ok(dealNeedsContact({ Contact_Name: { id: "9", name: "Sara" } }) === false, "deal with a contact does not");

ok(scoreLinkConfidence({ agreeing: 0, explicitDomain: false, relatedRecords: 0 }) === 40, "base 40");
ok(scoreLinkConfidence({ agreeing: 2, explicitDomain: true, relatedRecords: 3 }) === 100, "strong evidence caps at 100");
ok(scoreLinkConfidence({ agreeing: 1, explicitDomain: false, relatedRecords: 0 }) === 50, "one agreeing +10");

console.log(fail === 0 ? "recordLinkHints ok" : ("FAIL " + fail));
if (fail > 0) process.exit(1);
