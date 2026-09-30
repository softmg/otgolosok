import { distanceMeters } from "../../lib/geo/distance";
import type { Coordinates, Route } from "../tour/types";

export const nearbyRadii = [100, 200, 300] as const;
export type NearbyRadius = typeof nearbyRadii[number];

// Наименьший радиус, который перекрывает погрешность позиции; null — точка слишком грубая для поиска рядом.
export function nearbyRadiusForAccuracy(accuracyM: number): NearbyRadius | null {
  return nearbyRadii.find((radius) => accuracyM <= radius) ?? null;
}

export type NearbyStory = {
  id: string;
  title: string;
  address: string;
  location: Coordinates;
  durationSec: number;
  sourceCount: number;
  factCount: number;
};

export type NearbyRecommendation = NearbyStory & {
  distanceM: number;
  reason: string;
};

const clean = (value: string) => value.trim().replace(/\s+/g, " ");

export function nearbyStoryCatalog(route: Route): NearbyStory[] {
  const seen = new Set<string>();
  return route.pois.flatMap((poi) => {
    if (seen.has(poi.id) || poi.story.text_status !== "ready" || poi.story.duration_sec <= 0 || poi.sources.length === 0 || poi.facts.length === 0) return [];
    seen.add(poi.id);
    return [{
      id: poi.id,
      title: clean(poi.name),
      address: clean(poi.eyebrow),
      location: poi.viewpoint ?? poi.location,
      durationSec: poi.story.duration_sec,
      sourceCount: poi.sources.length,
      factCount: poi.facts.filter((fact) => fact.confidence === "verified").length,
    }];
  });
}

export function recommendNearbyStories(center: Coordinates, radiusM: NearbyRadius, catalog: NearbyStory[]): NearbyRecommendation[] {
  return catalog
    .map((story) => ({ ...story, distanceM: distanceMeters(center, story.location) }))
    .filter((story) => story.distanceM <= radiusM)
    .sort((left, right) => (
      right.factCount - left.factCount ||
      right.sourceCount - left.sourceCount ||
      left.distanceM - right.distanceM ||
      left.title.localeCompare(right.title, "ru")
    ))
    .slice(0, 3)
    .map((story, index) => ({
      ...story,
      reason: index === 0
        ? `Лучший подтверждённый рассказ: ${story.factCount} фактов и ${story.sourceCount} источников.`
        : `${Math.round(story.distanceM)} м по прямой · готовая история.`,
    }));
}
