// @vitest-environment jsdom

import { StrictMode, act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const revalidate = vi.fn(async () => {});
vi.mock("./map-cells", () => ({ mapCellStore: { revalidate } }));

type Module = typeof import("./place-story");
let placeStory: Module;
let root: Root;
let container: HTMLDivElement;
let latest: ReturnType<Module["usePlaceStory"]>;

const detail = (id: string, overrides: Record<string, unknown> = {}) => Response.json({ place: { id, text: {
  story: { title: "История", paragraphs: [{ text: "Первый абзац." }, { text: " " }, { text: "Второй абзац." }],
    sources: [{ publisher: "data.mos.ru", url: "https://data.mos.ru/opendata/1" }] },
  audio: { url: "/api/story-audio/a.mp3", durationSec: 61 }, ...overrides,
} } });

function Probe({ id }: { id?: string }) {
  latest = placeStory.usePlaceStory(id);
  return null;
}
const show = (id?: string) => act(async () => root.render(createElement(Probe, { id })));

beforeEach(async () => {
  vi.resetModules();
  revalidate.mockClear();
  placeStory = await import("./place-story");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("maps the published text, attribution and audio, and serves a reopened story from memory", async () => {
  const fetcher = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(async path => detail(path.split("/").at(-1)!));
  vi.stubGlobal("fetch", fetcher);
  await show("osm:node:1");
  expect(latest.status).toBe("ready");
  expect(latest.story).toEqual({
    paragraphs: ["Первый абзац.", "Второй абзац."],
    attribution: { url: "https://data.mos.ru/opendata/1", label: "Портал открытых данных Правительства Москвы" },
    audioUrl: "/api/story-audio/a.mp3", durationSec: 61,
  });
  expect(fetcher.mock.calls[0][0]).toBe("/api/content/places/osm:node:1");
  expect(fetcher.mock.calls[0][1]).toMatchObject({ cache: "no-cache" });
  await show(undefined);
  expect(latest.status).toBe("idle");
  await show("osm:node:1");
  expect(latest.status).toBe("ready");
  expect(fetcher).toHaveBeenCalledOnce();
});

it("keeps a story without audio free of a player", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => detail("osm:node:2", { audio: null })));
  await show("osm:node:2");
  expect(latest.story).toEqual({ paragraphs: ["Первый абзац.", "Второй абзац."], attribution: expect.anything() });
});

it("reports an unpublished story as missing and refreshes the map index", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 })));
  await show("osm:node:3");
  expect(latest.status).toBe("missing");
  expect(revalidate).toHaveBeenCalledOnce();
});

it("shows an error after a malformed response and succeeds on retry", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(Response.json({ place: { text: null } }))
    .mockResolvedValueOnce(detail("osm:node:4"));
  vi.stubGlobal("fetch", fetcher);
  await show("osm:node:4");
  expect(latest.status).toBe("error");
  await act(async () => latest.retry());
  expect(latest.status).toBe("ready");
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("aborts the previous request when another story opens", async () => {
  const signals: AbortSignal[] = [];
  vi.stubGlobal("fetch", vi.fn((path: string, init: RequestInit) => {
    signals.push(init.signal!);
    return path.endsWith("5") ? new Promise<Response>(() => {}) : Promise.resolve(detail("osm:node:6"));
  }));
  await show("osm:node:5");
  expect(latest.status).toBe("loading");
  await show("osm:node:6");
  expect(signals[0].aborted).toBe(true);
  expect(latest.status).toBe("ready");
});

it("shares one request between the StrictMode remount and a second sheet of the same place", async () => {
  const signals: AbortSignal[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, init: RequestInit) => { signals.push(init.signal!); return detail(path.split("/").at(-1)!); }));
  await act(async () => root.render(createElement(StrictMode, null, createElement(Probe, { id: "osm:node:7" }), createElement(Probe, { id: "osm:node:7" }))));
  expect(latest.status).toBe("ready");
  expect(signals).toHaveLength(1);
  expect(signals[0].aborted).toBe(false);
});

const photo = {
  thumbnail: `/api/place-images/${"1".repeat(64)}.jpg`, src: `/api/place-images/${"2".repeat(64)}.jpg`, width: 960, height: 720,
  alt: "Дом Пашкова", author: "NVO", sourceUrl: "https://commons.wikimedia.org/wiki/File:A.jpg",
  license: "CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0",
};
const storyWith = (value: unknown) => placeStory.parsePlaceStory({ place: { text: { story: { paragraphs: [{ text: "Абзац." }] } }, ...(value === undefined ? {} : { photo: value }) } });

it("reads the place photo, including an editorial copy and a photo without an author", () => {
  expect(storyWith(photo).photo).toEqual(photo);
  const editorial = { ...photo, thumbnail: "/images/places/way-1-7bb38a14d975.jpg", src: "/images/places/way-1-46765eae7280.jpg" };
  expect(storyWith(editorial).photo).toEqual(editorial);
  expect(storyWith({ ...photo, author: null }).photo).toEqual({ ...photo, author: null });
  expect(storyWith(undefined)).toEqual({ paragraphs: ["Абзац."] });
  expect(storyWith(null)).toEqual({ paragraphs: ["Абзац."] });
});

it.each([
  ["a foreign host", { thumbnail: "https://upload.wikimedia.org/a.jpg" }],
  ["a path traversal", { src: `/api/place-images/../${"2".repeat(64)}.jpg` }],
  ["a short hash", { src: "/api/place-images/abc.jpg" }],
  ["a zero width", { width: 0 }],
  ["a fractional height", { height: 1.5 }],
  ["an empty license", { license: " " }],
  ["an empty alt", { alt: "" }],
  ["a script source link", { sourceUrl: "javascript:alert(1)" }],
  ["a relative license link", { licenseUrl: "/license" }],
  ["a numeric author", { author: 7 }],
])("drops a photo with %s and keeps the story", (_, broken) => {
  expect(storyWith({ ...photo, ...broken })).toEqual({ paragraphs: ["Абзац."] });
});
