export type Coordinates = {
  lat: number;
  lon: number;
};

export type HistoricalContent = {
  story: {
    opening: string;
    duration_sec: number;
    duration_is_estimate: boolean;
    text_status: "draft" | "ready";
    revision: number;
    checked_at: string;
    paragraphs: Array<{
      id: string;
      text: string;
      fact_ids: string[];
    }>;
    layer: "official" | "resident";
    audio_url: string | null;
  };
  sources: Array<{
    id: string;
    title: string;
    url: string;
    publisher: string;
    kind: "collection" | "heritage_report" | "research_article" | "local_history";
    checked_at: string;
  }>;
  facts: Array<{
    id: string;
    claim: string;
    confidence: "verified" | "legend" | "unverified";
    evidence: Array<{
      source_id: string;
      locator: string;
      summary: string;
    }>;
  }>;
  editorial_note: string;
};

export type Poi = HistoricalContent & {
  id: string;
  name: string;
  eyebrow: string;
  location: Coordinates;
  viewpoint: Coordinates | null;
  viewpoint_pending: boolean;
  trigger: {
    enter_m: number;
    exit_m: number;
    min_fixes: number;
    max_accuracy_m: number;
  };
};

// Notes are available to read manually until route placement and audio are ready.
export type RouteNote = HistoricalContent & {
  id: string;
  kind: "street_name" | "everyday_life";
  place: string;
  related_poi_id: string;
};

export type WalkStep = {
  id: string;
  content_id: string;
  title: string;
  place: string;
  location: Coordinates;
  transition: string;
  next_hint: string;
  duration_sec: number;
  // Where the walker has to be for this chapter to start, when that differs from
  // the building it describes: a house set back from the route is still reached
  // from the street. The map pin stays on `location`.
  trigger_location?: Coordinates;
  // Set per stop once its approach is checked on the ground; the first POI's
  // trigger is used until then.
  trigger?: {
    enter_m: number;
    exit_m: number;
    min_fixes: number;
    max_accuracy_m: number;
  };
  // Universal walk views keep stops visible while their story is preparing.
  status?: "not_requested" | "preparing" | "text_ready" | "ready" | "failed" | "review_required" | "insufficient_evidence" | "unavailable";
  audio?: {
    url: string;
    duration_sec: number;
    synthetic: boolean;
    model: string;
    voice: string;
    script_sha256: string;
    audio_sha256: string;
    generated_at: string;
  };
};

export type WalkPlan = {
  start: { address: string; location: Coordinates; osm_id: string };
  finish: { address: string; location: Coordinates; osm_id: string };
  distance_m: number;
  walking_min: number;
  field_checked: boolean;
  path: {
    coordinates: number[][];
    provider: string;
    source_url: string;
    checked_at: string;
    costing: "pedestrian";
  };
  steps: WalkStep[];
};

export type Route = {
  id: string;
  title: string;
  subtitle: string;
  city: string;
  duration_min: number;
  distance_km: number;
  poi_count: number;
  status: "draft" | "published";
  pois: Poi[];
  notes?: RouteNote[];
  walk?: WalkPlan;
};
