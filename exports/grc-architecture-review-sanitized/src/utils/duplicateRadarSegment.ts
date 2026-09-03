// JS mirror of buildSegmentPredicate's SQL layout classification (DRD:165-215),
// used to attribute a resolved-cluster survivor (whose layout we read from
// duplicate_records) to a segment in application code.
export type RadarSegment = "marketplace" | "ExampleOrg" | "walaone";

export function classifySegmentFromLayout(
  layout: string | null | undefined,
): RadarSegment {
  const norm = (layout ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (norm.includes("marketplace") || norm.includes("partneraccounts")) {
    return "marketplace";
  }
  if (norm.includes("walaone")) return "walaone";
  return "ExampleOrg"; // includes blank/legacy corporate
}
