export type Coordinates = { lat: number; lon: number };
export type Place = { address: string; location: Coordinates };
export type StoryRef = { kind: "job" | "osm" | "catalog"; id: string } | null;
export type WalkStop = { id: string; place: Place; storyRef: StoryRef; transition: string; nextHint: string; triggerLocation?: Coordinates };
export type WalkDocument = {
  version: 2; id: string; title: string; description: string; city: "Москва"; mode: "open" | "loop";
  minutes: number; start: Place | null; destination?: Place | null; stops: WalkStop[];
  route: { geometry: Coordinates[]; distanceM: number; walkingMinutes: number; attribution: string } | null;
  fieldChecked: boolean;
};
export type WalkStory = { title: string; address: string; paragraphs: Array<{ text: string; factIds: string[] }>;
  sources: Array<{ id: string; title: string; url: string; publisher: string }>;
  facts: Array<{ id: string; claim: string; sourceIds: string[] }>; checkedAt?: string };
export type WalkAudio = { url: string; sha256: string; durationSec: number };
export type WalkView = { document: WalkDocument; revision: number; contentVersion: string;
  chapters: Array<{ id: string; status: "not_requested" | "preparing" | "text_ready" | "ready" | "failed" | "review_required" | "insufficient_evidence" | "unavailable";
    story: WalkStory | null; audio: WalkAudio | null }> };

export { validateWalkDocument, migrateLegacyDraft, validateWalkView } from "../../../backend/walk-document.mjs";
