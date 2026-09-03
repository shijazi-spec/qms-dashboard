import assert from "node:assert";
import { isZohoGhostError } from "./emptyRecordsDatabase";

// Ghost detection: Zoho's "deleted record" signals → prune, not error.
assert(
  isZohoGhostError(
    'Zoho Attachments API error: 400 - {"code":"INVALID_DATA","message":"the related id given seems to be invalid"}',
  ) === true,
  "INVALID_DATA / related-id message is a ghost",
);
assert(isZohoGhostError("record not found") === true, "record not found is a ghost");
assert(
  isZohoGhostError(new Error("The related id given seems to be invalid")) === true,
  "Error instance with related-id message is a ghost",
);
assert(isZohoGhostError("0 attachments") === false, "a normal empty result is NOT a ghost");
assert(isZohoGhostError(null) === false, "null is not a ghost");

console.log("isZohoGhostError ok");
