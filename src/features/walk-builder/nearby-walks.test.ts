// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Coordinates } from "../tour/types";
import type { WalkDocument } from "../walks/model";
import { saveLocalWalk } from "../walks/local-store";
import type { EditingWalk } from "../walks/nearby-model";
import { DRAFT_KEY, emptyDraft } from "./model";
import { useNearbyWalks } from "./use-nearby-walks";
import { WalkCreationPanel } from "./walk-creation-panel";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }) }));

const TOKEN = "22222222-2222-4222-8222-222222222222";
const START = { lat: 55.75, lon: 37.6 };
const card = { walkingMinutes: 45, distanceM: 3200, stopCount: 6, rating: { average: 4.5, count: 2 }, startDistanceM: 350, finish: "Москва, Садовническая улица, 5" };
const walks = [
  { ...card, kind: "catalog", id: "msk-walk", title: "Кожевники" },
  { ...card, kind: "shared", id: TOKEN, title: "Арбат", rating: { average: null, count: 0 }, startDistanceM: 0, finish: null },
];

let root: Root;
let container: HTMLDivElement;
let nearby: (url: URL, init: RequestInit) => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  nearby = async () => Response.json({ walks });
  fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/walks/nearby") return nearby(url, init);
    if (url.pathname === "/api/auth/session") return Response.json({ user: null });
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

const nearbyCalls = () => fetchMock.mock.calls.map(([url]) => String(url)).filter(url => url.includes("/api/walks/nearby"));
const section = () => container.querySelector('[data-creation="nearby"]');
const button = (name: string) => [...container.querySelectorAll("button")].find(item => item.getAttribute("aria-label") === name || item.textContent === name);

describe("подборка в панели создания", () => {
  const start = { address: "Москва, Арбат, 1", location: START };
  async function openDraft(draft: object) {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...emptyDraft(), ...draft }));
    history.replaceState(null, "", "/?walk=create&resume=1");
    await act(async () => { root.render(createElement(WalkCreationPanel, { onClose: () => {}, onMap: () => {}, picked: null })); });
  }

  it("показывает готовые прогулки рядом с выбранным стартом", async () => {
    await openDraft({ start });
    expect(new URL(nearbyCalls()[0], "http://localhost").search).toBe("?lat=55.75000&lon=37.60000");
    // Collapsed by default: only the summary takes height until the user opens it.
    const details = section() as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("Прогулки рядом · 2");
    await act(async () => { details.querySelector("summary")?.click(); });
    expect(details.open).toBe(true);
    const links = [...section()!.querySelectorAll("a")];
    expect(links.map(link => link.getAttribute("href"))).toEqual(["/walk?catalog=msk-walk", `/walk?share=${TOKEN}`]);
    expect(links[0].textContent).toContain("45 мин · 3,2 км · 6 историй · старт в 350 м");
    expect(links[1].textContent).toContain("Пока без оценок");
    expect(links[1].textContent).toContain("старт рядом");
    expect(links[0].textContent).toContain("до Садовническая улица, 5");
    expect(links[1].textContent).toContain("по кругу, обратно к старту");
    expect(links[0].textContent).not.toContain("Ваша");
  });

  it("прячет подборку, пока открыт выбор точки", async () => {
    await openDraft({ start });
    expect(section()).not.toBeNull();
    await act(async () => { button("Откуда")?.click(); });
    expect(section()).toBeNull();
  });

  it("не запрашивает подборку без старта и после построения маршрута", async () => {
    await openDraft({});
    const stop = { address: "Москва, Арбат, 20", location: { lat: 55.752, lon: 37.6 } };
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await openDraft({ start, stops: [stop], route: { stops: [stop], geometry: [start.location, stop.location], walkingMinutes: 25, distanceM: 1800, attribution: "OSM" } });
    expect(nearbyCalls()).toEqual([]);
    expect(section()).toBeNull();
  });

  function allowGeolocation(state: PermissionState, accuracy = 30) {
    const getCurrentPosition = vi.fn((success: PositionCallback) => success({ coords: { latitude: 55.7262, longitude: 37.6485, accuracy }, timestamp: 0 } as GeolocationPosition));
    vi.stubGlobal("navigator", { ...navigator, geolocation: { getCurrentPosition, watchPosition: () => 1, clearWatch: () => {} }, permissions: { query: async () => ({ state }) } });
    return getCurrentPosition;
  }

  it("без старта показывает прогулки близко к пользователю, если геолокация уже разрешена", async () => {
    allowGeolocation("granted");
    await openDraft({});
    await vi.waitFor(() => expect(section()).not.toBeNull());
    expect(new URL(nearbyCalls()[0], "http://localhost").search).toBe("?lat=55.72620&lon=37.64850");
    expect(section()?.querySelector("summary")?.textContent).toBe("Близко к вам · 2");
    const links = [...section()!.querySelectorAll("a")];
    expect(links[0].textContent).toContain("в 350 м от вас");
    expect(links[1].textContent).toContain("рядом с вами");
  });

  it("не спрашивает геолокацию ради подборки и не берёт слишком грубую точку", async () => {
    const asked = allowGeolocation("prompt");
    await openDraft({});
    expect(asked).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    allowGeolocation("granted", 2_000);
    await openDraft({});
    expect(nearbyCalls()).toEqual([]);
    expect(section()).toBeNull();
  });

  it("с выбранным стартом считает от старта, а не от пользователя", async () => {
    const asked = allowGeolocation("granted");
    await openDraft({ start });
    expect(asked).not.toHaveBeenCalled();
    expect(section()?.querySelector("summary")?.textContent).toBe("Прогулки рядом · 2");
  });

  it("без результатов блок не показывается", async () => {
    nearby = async () => Response.json({ walks: [] });
    await openDraft({ start });
    expect(nearbyCalls()).toHaveLength(1);
    expect(section()).toBeNull();
  });
});

function Harness({ start, exclude = null }: { start: Coordinates | null; exclude?: EditingWalk | null }) {
  const items = useNearbyWalks(start, exclude, true);
  return createElement("ol", null, items.map(item => createElement("li", { key: item.id }, `${item.kind}:${item.id}`)));
}
const shown = () => [...container.querySelectorAll("li")].map(item => item.textContent);
const localWalk = (id: string): WalkDocument => {
  const stop = { lat: START.lat + 0.001, lon: START.lon };
  return { version: 2, id, title: "Своя", description: "", city: "Москва", mode: "open", minutes: 30, start: { address: "Москва, Арбат, 1", location: START },
    stops: [{ id: "11111111-1111-4111-8111-111111111111", place: { address: "Москва, Арбат, 2", location: stop }, storyRef: null, transition: "", nextHint: "" }],
    route: { geometry: [START, stop], distanceM: 400, walkingMinutes: 5, attribution: "OSM" }, fieldChecked: false };
};

describe("загрузка подборки", () => {
  const LOCAL = "44444444-4444-4444-8444-444444444444";

  it("при сбое сервиса показывает только прогулки этого браузера", async () => {
    saveLocalWalk(localStorage, localWalk(LOCAL), null);
    nearby = async () => Response.json({ walks: [{ kind: "local", id: LOCAL }] });
    await act(async () => { root.render(createElement(Harness, { start: START })); });
    expect(shown()).toEqual([`local:${LOCAL}`]);
  });

  it("повреждённое хранилище не ломает подборку", async () => {
    localStorage.setItem("otgolosok:walks:v2", "{broken");
    await act(async () => { root.render(createElement(Harness, { start: START })); });
    expect(shown()).toEqual(["catalog:msk-walk", `shared:${TOKEN}`]);
  });

  it("не предлагает открытую локальную прогулку", async () => {
    saveLocalWalk(localStorage, localWalk(LOCAL), null);
    await act(async () => { root.render(createElement(Harness, { start: START, exclude: { kind: "local", id: LOCAL } })); });
    expect(shown()).toEqual(["catalog:msk-walk", `shared:${TOKEN}`]);
  });

  it("смена старта отменяет прежний запрос", async () => {
    const signals: AbortSignal[] = [];
    nearby = (url, init) => {
      signals.push(init.signal!);
      if (url.searchParams.get("lat") === "55.75000") return new Promise<Response>(() => {});
      return Promise.resolve(Response.json({ walks: walks.slice(0, 1) }));
    };
    await act(async () => { root.render(createElement(Harness, { start: START })); });
    await act(async () => { root.render(createElement(Harness, { start: { lat: 55.76, lon: 37.6 } })); });
    expect(signals[0].aborted).toBe(true);
    expect(shown()).toEqual(["catalog:msk-walk"]);
  });
});
