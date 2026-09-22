import type { Route } from "./types";
import { TourExperience } from "./tour-experience";

export function CatalogTour({ route }: { route: Route }) {
  return <TourExperience route={route} />;
}
