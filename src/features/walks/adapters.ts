import { validateWalkDocument, validateWalkView, type WalkAudio, type WalkDocument, type WalkStory, type WalkView } from "./model";
import type { Draft, Place as DraftPlace, StoryRef as DraftStoryRef } from "../walk-builder/model";
import type { Coordinates, HistoricalContent, Poi, Route, WalkStep } from "../tour/types";
import { isJobId, placeKey } from "../walk-builder/model";

const defaultTrigger = {
  enter_m: 35,
  exit_m: 60,
  min_fixes: 3,
  max_accuracy_m: 50,
};

function samePlace(left: { location: Coordinates }, right: { location: Coordinates }) {
  return left.location.lat === right.location.lat && left.location.lon === right.location.lon;
}

function stopId(walkId: string, index: number) {
  return `${walkId}-stop-${index}`.slice(0, 128);
}

function jobFor(place: DraftPlace, jobs: DraftStoryRef[]) {
  const job = jobs.find(item => placeKey(item.place) === placeKey(place) && isJobId(item.id));
  return job ? { kind: "job" as const, id: job.id } : null;
}

function storyFor(place: DraftPlace, jobs: DraftStoryRef[]) {
  return jobFor(place, jobs) ?? (place.contentId ? { kind: "osm" as const, id: place.contentId } : null);
}

function storyStopPlaces(draft: Draft) {
  const startStory = draft.start && jobFor(draft.start, draft.jobs) ? [draft.start] : [];
  return [...startStory, ...draft.stops];
}

export function draftToWalkDocument(draft: Draft, id: string, previous?: WalkDocument | null): WalkDocument {
  const oldByPlace = new Map((previous?.stops ?? []).map(stop => [placeKey(stop.place), stop]));
  const stops = storyStopPlaces(draft).map((place, index) => {
    const old = oldByPlace.get(placeKey(place));
    return {
      id: old?.id ?? stopId(id, index),
      place: { address: place.address, location: { ...place.location } },
      storyRef: storyFor(place, draft.jobs),
      transition: old?.transition ?? "",
      nextHint: old?.nextHint ?? "",
      ...(old?.triggerLocation ? { triggerLocation: { ...old.triggerLocation } } : {}),
    };
  });

  return validateWalkDocument({
    version: 2,
    id,
    title: draft.title || "Моя прогулка",
    description: "",
    city: "Москва",
    ...(draft.destination ? { destination: draft.destination } : {}),
    mode: draft.mode,
    minutes: draft.minutes,
    start: draft.start ? { address: draft.start.address, location: { ...draft.start.location } } : null,
    stops,
    route: draft.route ? {
      geometry: draft.route.geometry.map(point => ({ ...point })),
      distanceM: draft.route.distanceM,
      walkingMinutes: draft.route.walkingMinutes,
      attribution: draft.route.attribution,
    } : null,
    fieldChecked: false,
  });
}

function jobDrafts(document: WalkDocument, previousJobs: DraftStoryRef[]) {
  return document.stops.flatMap(stop => {
    if (!stop.storyRef || stop.storyRef.kind !== "job" || !isJobId(stop.storyRef.id)) return [];
    const previous = previousJobs.find(job => job.id === stop.storyRef?.id);
    return [{
      place: { ...stop.place, location: { ...stop.place.location } },
      id: stop.storyRef.id,
      stage: previous?.stage ?? "queued",
    } satisfies DraftStoryRef];
  });
}

export function walkDocumentToDraft(document: WalkDocument, previousJobs: DraftStoryRef[] = []): Draft {
  const firstIsStartStory = Boolean(document.start && document.stops[0] && samePlace(document.start, document.stops[0].place)
    && document.stops[0].storyRef?.kind === "job");
  const routeStops = document.stops.filter((_, index) => !(firstIsStartStory && index === 0));
  return {
    version: 1,
    title: document.title,
    start: document.start ? { ...document.start, location: { ...document.start.location } } : null,
    ...(document.destination ? { destination: document.destination } : {}),
    mode: document.mode,
    minutes: document.minutes === 15 ? 30 : document.minutes as 30 | 60 | 90,
    stops: routeStops.map(stop => ({ ...stop.place, location: { ...stop.place.location }, ...(stop.storyRef?.kind === "osm" ? { contentId: stop.storyRef.id } : {}) })),
    route: document.route ? {
      stops: routeStops.map(stop => ({ ...stop.place, location: { ...stop.place.location } })),
      geometry: document.route.geometry.map(point => ({ ...point })),
      distanceM: document.route.distanceM,
      walkingMinutes: document.route.walkingMinutes,
      attribution: document.route.attribution,
    } : null,
    jobs: jobDrafts(document, previousJobs),
    submitting: null,
  };
}

function dateOnly(value: string | undefined) {
  return value?.slice(0, 10) || "";
}

function walkStoryToHistorical(story: WalkStory | null, revision: number): HistoricalContent {
  if (!story) return {
    story: {
      opening: "История ещё готовится",
      duration_sec: 0,
      duration_is_estimate: true,
      text_status: "draft",
      revision,
      checked_at: "",
      paragraphs: [],
      layer: "official",
      audio_url: null,
    },
    sources: [],
    facts: [],
    editorial_note: "История станет доступна после проверки источников.",
  };
  return {
    story: {
      opening: story.title,
      duration_sec: Math.max(1, Math.round(story.paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0) / 12)),
      duration_is_estimate: true,
      text_status: "ready",
      revision,
      checked_at: dateOnly(story.checkedAt),
      paragraphs: story.paragraphs.map((paragraph, index) => ({ id: `${revision}-${index}`, text: paragraph.text, fact_ids: paragraph.factIds })),
      layer: "official",
      audio_url: null,
    },
    sources: story.sources.map(source => ({
      id: source.id,
      title: source.title,
      url: source.url,
      publisher: source.publisher,
      kind: "research_article",
      checked_at: dateOnly(story.checkedAt),
    })),
    facts: story.facts.map(fact => ({
      id: fact.id,
      claim: fact.claim,
      confidence: "verified",
      evidence: fact.sourceIds.map(sourceId => ({ source_id: sourceId, locator: "", summary: "" })),
    })),
    editorial_note: "Источники и факты доступны в карточке остановки.",
  };
}

function audioToLegacy(audio: WalkAudio | null): WalkStep["audio"] {
  if (!audio) return undefined;
  return {
    url: audio.url,
    duration_sec: audio.durationSec,
    synthetic: true,
    model: "published",
    voice: "published",
    script_sha256: audio.sha256,
    audio_sha256: audio.sha256,
    generated_at: "",
  };
}

function chapterToPoi(view: WalkView, index: number): { poi: Poi; step: WalkStep } {
  const stop = view.document.stops[index];
  const chapter = view.chapters[index];
  const content = walkStoryToHistorical(chapter.story, view.revision);
  const poi: Poi = {
    id: stop.id,
    name: chapter.story?.title ?? stop.place.address,
    eyebrow: stop.place.address,
    location: stop.place.location,
    viewpoint: stop.triggerLocation ?? stop.place.location,
    viewpoint_pending: !stop.triggerLocation,
    trigger: defaultTrigger,
    ...content,
  };
  const step: WalkStep = {
    id: stop.id,
    content_id: stop.id,
    title: chapter.story?.title ?? stop.place.address,
    place: stop.place.address,
    location: stop.place.location,
    transition: stop.transition,
    next_hint: stop.nextHint,
    duration_sec: Math.ceil(chapter.audio?.durationSec ?? content.story.duration_sec),
    ...(stop.triggerLocation ? { trigger_location: stop.triggerLocation } : {}),
    trigger: defaultTrigger,
    status: chapter.status,
    ...(audioToLegacy(chapter.audio) ? { audio: audioToLegacy(chapter.audio) } : {}),
  };
  return { poi, step };
}

export function walkViewToRoute(input: WalkView): Route {
  validateWalkView(input);
  const view = input;
  const chapters = view.document.stops.map((_, index) => chapterToPoi(view, index));
  const anchor = view.document.start ?? view.document.stops[0]?.place ?? { address: "Маршрут ещё не построен", location: { lat: 55.75, lon: 37.61 } };
  const finish = view.document.destination ?? (view.document.mode === "loop" ? anchor : view.document.stops.at(-1)?.place ?? anchor);
  const route = view.document.route;
  const poi = chapters.length ? chapters.map(item => item.poi) : [{
    id: `${view.document.id}-start`,
    name: anchor.address,
    eyebrow: anchor.address,
    location: anchor.location,
    viewpoint: anchor.location,
    viewpoint_pending: true,
    trigger: defaultTrigger,
    ...walkStoryToHistorical(null, view.revision),
  } satisfies Poi];
  return {
    id: view.document.id,
    title: view.document.title,
    subtitle: view.document.description,
    city: view.document.city,
    duration_min: route?.walkingMinutes ?? view.document.minutes,
    distance_km: route ? route.distanceM / 1000 : 0,
    poi_count: chapters.length,
    status: route ? "published" : "draft",
    pois: poi,
    notes: [],
    walk: {
      start: { address: anchor.address, location: anchor.location, osm_id: "" },
      finish: { address: finish.address, location: finish.location, osm_id: "" },
      distance_m: route?.distanceM ?? 0,
      walking_min: route?.walkingMinutes ?? view.document.minutes,
      field_checked: view.document.fieldChecked,
      path: { coordinates: route?.geometry.map(point => [point.lon, point.lat]) ?? [], provider: route?.attribution ?? "", source_url: "", checked_at: "", costing: "pedestrian" },
      steps: chapters.map(item => item.step),
    },
  };
}

function contentToWalkStory(content: HistoricalContent, address: string): WalkStory | null {
  if (content.story.text_status !== "ready" || content.story.paragraphs.length === 0) return null;
  return {
    title: content.story.opening,
    address,
    paragraphs: content.story.paragraphs.map(paragraph => ({ text: paragraph.text, factIds: paragraph.fact_ids })),
    sources: content.sources.map(source => ({ id: source.id, title: source.title, url: source.url, publisher: source.publisher })),
    facts: content.facts.map(fact => ({ id: fact.id, claim: fact.claim, sourceIds: fact.evidence.map(evidence => evidence.source_id) })),
    ...(content.story.checked_at ? { checkedAt: dateOnly(content.story.checked_at) } : {}),
  };
}

export function routeToWalkView(route: Route): WalkView {
  const steps = route.walk?.steps ?? [];
  const contentById = new Map([...route.pois, ...(route.notes ?? [])].map(content => [content.id, content]));
  const cleanPlace = (value: string) => value.replace(/^Финиш:\s*/i, "");
  const stops = steps.map(step => ({
    id: step.id,
    place: { address: cleanPlace(step.place), location: { ...step.location } },
    storyRef: { kind: "catalog" as const, id: `${route.id}--${step.content_id}` },
    transition: step.transition,
    nextHint: step.next_hint,
    ...(step.trigger_location ? { triggerLocation: { ...step.trigger_location } } : {}),
  }));
  const chapters = steps.map(step => {
    const content = contentById.get(step.content_id);
    const story = content ? contentToWalkStory(content, cleanPlace(step.place)) : null;
    const audio = step.audio && /^[a-f0-9]{64}$/.test(step.audio.audio_sha256) ? {
      url: step.audio.url,
      sha256: step.audio.audio_sha256,
      durationSec: step.audio.duration_sec,
    } : null;
    return { id: step.id, status: audio ? "ready" as const : story ? "text_ready" as const : "unavailable" as const, story, audio };
  });
  const start = route.walk?.start ? { address: route.walk.start.address, location: { ...route.walk.start.location } } : null;
  const geometry = route.walk?.path.coordinates.map(([lon, lat]) => ({ lat, lon })) ?? [];
  return validateWalkView({
    document: {
      version: 2,
      id: route.id,
      title: route.title,
      description: route.subtitle,
      city: "Москва",
      mode: "open",
      minutes: [15, 30, 60, 90].includes(route.duration_min) ? route.duration_min : 30,
      start,
      stops,
      route: geometry.length >= 2 && route.walk ? { geometry, distanceM: route.walk.distance_m, walkingMinutes: route.walk.walking_min, attribution: route.walk.path.provider } : null,
      fieldChecked: route.walk?.field_checked ?? false,
    },
    revision: 0,
    contentVersion: `catalog:${route.id}:${route.walk?.steps.length ?? 0}`,
    chapters,
  });
}
