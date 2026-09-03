import assert from "node:assert";
import { isCRMProviderGhostError } from "./emptyRecordsDatabase";

// Ghost detection: CRMProvider's "deleted record" signals → prune, not error.
assert(
  isCRMProviderGhostError(
    'CRMProvider Attachments API error: 400 - {"code":"INVALID_DATA","message":"the related id given seems to be invalid"}',
  ) === true,
  "INVALID_DATA / related-id message is a ghost",
);
assert(isCRMProviderGhostError("record not found") === true, "record not found is a ghost");
assert(
  isCRMProviderGhostError(new Error("The related id given seems to be invalid")) === true,
  "Error instance with related-id message is a ghost",
);
assert(isCRMProviderGhostError("0 attachments") === false, "a normal empty result is NOT a ghost");
assert(isCRMProviderGhostError(null) === false, "null is not a ghost");

console.log("isCRMProviderGhostError ok");
