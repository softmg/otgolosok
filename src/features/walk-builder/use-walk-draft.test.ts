// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useWalkDraft } from "./use-walk-draft";
import { DRAFT_KEY, emptyDraft } from "./model";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }) }));
vi.mock("../auth/client", () => ({ getSession: async () => null }));
vi.mock("./request", async importOriginal => ({ ...await importOriginal<object>(), request: async () => ({ id: "11111111-1111-4111-8111-111111111111", stage: "ready" }) }));
afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });

it("не записывает сорок первую главу и сохраняет возможность редактировать прогулку", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  history.replaceState(null, "", "/walk/create?resume=1");
  const start = { address: "Москва, Арбат, 1", location: { lat: 55.75, lon: 37.60 } };
  const stops = Array.from({ length: 39 }, (_, index) => ({ address: `Москва, Арбат, ${index + 2}`, location: { lat: 55.751 + index * 0.001, lon: 37.601 } }));
  localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...emptyDraft(), start, stops, jobs: [{ id: "11111111-1111-4111-8111-111111111111", place: start, stage: "ready" }] }));
  let hook: ReturnType<typeof useWalkDraft>;
  function Harness() { hook = useWalkDraft(); return null; }
  const container = document.createElement("div"), root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(Harness)); });
    expect(hook!.storageError).toBe("");
    const before = localStorage.getItem(DRAFT_KEY);
    const candidate = { address: "Москва, Арбат, 41", location: { lat: 55.791, lon: 37.601 } };
    await act(async () => { hook!.setTarget("stop"); hook!.setCandidate(candidate); });
    await act(async () => { hook!.confirmPlace(); });
    expect(hook!.draft.stops).toEqual(stops);
    expect(hook!.error).toContain("39");
    expect(hook!.storageError).toBe("");
    expect(localStorage.getItem(DRAFT_KEY)).toBe(before);
    await act(async () => { hook!.edit({ stops: [...stops, candidate] }); });
    expect(hook!.draft.stops).toEqual(stops);
    expect(localStorage.getItem(DRAFT_KEY)).toBe(before);
    await act(async () => { hook!.edit({ stops: stops.slice(0, -1) }); });
    await act(async () => { hook!.confirmPlace(); });
    expect(hook!.draft.stops).toHaveLength(39);
    expect(hook!.draft.stops.at(-1)).toEqual(candidate);
    expect(hook!.storageError).toBe("");
    expect(JSON.parse(localStorage.getItem(DRAFT_KEY)!).stops.at(-1)).toEqual(candidate);
  } finally { await act(async () => { root.unmount(); }); history.replaceState(null, "", "/"); }
});
