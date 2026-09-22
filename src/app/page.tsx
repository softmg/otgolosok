import { Suspense } from "react";
import { CatalogTour } from "@/features/tour/catalog-tour";
import type { Route } from "@/features/tour/types";
import route from "../../public/data/routes/paveletskaya.json";

export default function Home() {
  return <Suspense><CatalogTour route={route as Route} /></Suspense>;
}
