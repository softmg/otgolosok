export type ExplorePanel = "place" | "nearby" | "none";

export function selectExplorePanel({
  nearbyCenter = false,
  place = false,
  placeBusy = false,
  placeError = false,
}: {
  nearbyCenter?: boolean;
  place?: boolean;
  placeBusy?: boolean;
  placeError?: boolean;
}): ExplorePanel {
  if (place || placeBusy || placeError) return "place";
  if (nearbyCenter) return "nearby";
  return "none";
}
