import type { MapItem } from "./explore-map";
import type { SourceAttribution } from "./source-attribution";

/** A story on the home map: a walk chapter, a prepared job or a catalog place. */
export type StoryPin = MapItem & {
  address: string;
  duration?: number;
  chapter?: number;
  jobId?: string;
  placeId?: string;
  audioUrl?: string;
  status?: string;
  paragraphs?: string[];
  attribution?: SourceAttribution;
};
