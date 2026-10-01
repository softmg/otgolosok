import { useCallback, useEffect, useState } from "react";
import { RequestError, fetchWithRetry } from "../walk-builder/request";
import { mapCellStore } from "./map-cells";
import { openDataAttribution, type SourceAttribution, type StorySourceRef } from "./source-attribution";

/** A place photo served from our own origin, with the author and license credit shown under the full image. */
export type PlacePhoto = {
  src: string;
  thumbnail: string;
  width: number;
  height: number;
  alt: string;
  author: string | null;
  sourceUrl: string;
  license: string;
  licenseUrl: string;
};
export type PlaceStory = { paragraphs: string[]; attribution?: SourceAttribution; audioUrl?: string; durationSec?: number; photo?: PlacePhoto };
export type PlaceStoryState = { status: "idle" | "loading" | "ready" | "missing" | "error"; story?: PlaceStory; retry: () => void };

const CACHE_LIMIT = 100;
// Reopening a story within the session makes no request; the browser HTTP cache revalidates the rest by ETag.
const stories = new Map<string, PlaceStory>();

function remember(id: string, story: PlaceStory) {
  stories.delete(id);
  stories.set(id, story);
  if (stories.size > CACHE_LIMIT) stories.delete(stories.keys().next().value as string);
}

const PHOTO_PATH = /^(?:\/api\/place-images\/[a-f0-9]{64}|\/images\/places\/[a-z0-9-]+)\.jpg$/;
const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;
const webUrl = (value: unknown) => {
  if (typeof value !== "string") return undefined;
  try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined; }
  catch { return undefined; }
};
const size = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0 ? value as number : undefined;

/** The photo of a place detail; anything malformed means no photo, never a broken story. */
export function parsePlacePhoto(value: unknown): PlacePhoto | undefined {
  if (!value || typeof value !== "object") return undefined;
  const photo = value as Record<string, unknown>;
  const thumbnail = typeof photo.thumbnail === "string" && PHOTO_PATH.test(photo.thumbnail) ? photo.thumbnail : undefined;
  const src = typeof photo.src === "string" && PHOTO_PATH.test(photo.src) ? photo.src : undefined;
  const width = size(photo.width), height = size(photo.height), alt = text(photo.alt), license = text(photo.license);
  const sourceUrl = webUrl(photo.sourceUrl), licenseUrl = webUrl(photo.licenseUrl);
  if (photo.author !== null && typeof photo.author !== "string") return undefined;
  if (!thumbnail || !src || !width || !height || !alt || !license || !sourceUrl || !licenseUrl) return undefined;
  return { thumbnail, src, width, height, alt, author: text(photo.author) ?? null, sourceUrl, license, licenseUrl };
}

/** Maps `GET /api/content/places/:id` to the sheet body; a body without a published text is malformed. */
export function parsePlaceStory(value: unknown): PlaceStory {
  const place = (value as { place?: { text?: { story?: unknown; audio?: unknown }; photo?: unknown } } | null)?.place;
  const placeText = place?.text;
  const story = placeText?.story as { paragraphs?: unknown; sources?: unknown } | null | undefined;
  if (!story || typeof story !== "object" || !Array.isArray(story.paragraphs)) throw new Error("Некорректный ответ рассказа.");
  const paragraphs = (story.paragraphs as Array<{ text?: unknown } | null>)
    .map(paragraph => paragraph?.text).filter((paragraph): paragraph is string => typeof paragraph === "string" && paragraph.trim().length > 0);
  const audio = placeText?.audio as { url?: unknown; durationSec?: unknown } | null | undefined;
  const audioUrl = typeof audio?.url === "string" && audio.url ? audio.url : undefined;
  const durationSec = audioUrl && typeof audio?.durationSec === "number" && Number.isFinite(audio.durationSec) && audio.durationSec > 0 ? audio.durationSec : undefined;
  const attribution = openDataAttribution(Array.isArray(story.sources) ? story.sources as StorySourceRef[] : undefined);
  const photo = parsePlacePhoto(place?.photo);
  return { paragraphs, ...(attribution ? { attribution } : {}), ...(audioUrl ? { audioUrl } : {}), ...(durationSec ? { durationSec } : {}), ...(photo ? { photo } : {}) };
}

/** null: the story was unpublished after the map index was loaded. */
export async function loadPlaceStory(id: string, signal: AbortSignal): Promise<PlaceStory | null> {
  const cached = stories.get(id);
  if (cached) { remember(id, cached); return cached; }
  try {
    // no-cache: the browser revalidates its copy with the server ETag and hands a 304 back as the cached 200.
    const response = await fetchWithRetry(`/api/content/places/${id}`, signal, { cache: "no-cache" });
    const story = parsePlaceStory(await response.json());
    remember(id, story);
    return story;
  } catch (error) {
    if (error instanceof RequestError && error.status === 404) return null;
    throw error;
  }
}

type Pending = { promise: Promise<PlaceStory | null>; controller: AbortController; users: number };
const pending = new Map<string, Pending>();

/**
 * One request per place for every open consumer. The abort is deferred by a microtask so a StrictMode
 * remount or a second sheet of the same place picks the running request up instead of starting another.
 */
function acquireStory(id: string) {
  let entry = pending.get(id);
  if (!entry) {
    const controller = new AbortController();
    const created: Pending = { controller, users: 0, promise: loadPlaceStory(id, controller.signal) };
    created.promise.then(() => undefined, () => undefined).finally(() => { if (pending.get(id) === created) pending.delete(id); });
    pending.set(id, created);
    entry = created;
  }
  const held = entry;
  held.users += 1;
  let released = false;
  return {
    promise: held.promise,
    release() {
      if (released) return;
      released = true;
      held.users -= 1;
      queueMicrotask(() => {
        if (held.users > 0) return;
        held.controller.abort();
        if (pending.get(id) === held) pending.delete(id);
      });
    },
  };
}

export function usePlaceStory(placeId: string | undefined): PlaceStoryState {
  // The result belongs to one place and one attempt: anything else is still loading.
  const [state, setState] = useState<{ id: string; attempt: number; status: "ready" | "missing" | "error"; story?: PlaceStory } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  useEffect(() => {
    if (!placeId || stories.has(placeId)) return;
    let disposed = false;
    const request = acquireStory(placeId);
    request.promise.then(story => {
      if (disposed) return;
      if (story) { setState({ id: placeId, attempt, status: "ready", story }); return; }
      setState({ id: placeId, attempt, status: "missing" });
      // The index still shows a gone story: refresh it so the marker disappears.
      void mapCellStore.revalidate();
    }, () => {
      if (!disposed) setState({ id: placeId, attempt, status: "error" });
    });
    return () => { disposed = true; request.release(); };
  }, [placeId, attempt]);
  if (!placeId) return { status: "idle", retry };
  const cached = stories.get(placeId);
  if (cached) return { status: "ready", story: cached, retry };
  if (state?.id === placeId && state.attempt === attempt) return { status: state.status, story: state.story, retry };
  return { status: "loading", retry };
}
