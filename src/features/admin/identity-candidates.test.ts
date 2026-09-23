// @vitest-environment jsdom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdentityCandidates } from "./identity-candidates";
import type { AdminApi, AdminRun, ContentBatch, IdentityCandidate, IdentityCandidatePage } from "./model";

const candidates: IdentityCandidate[] = [
  { placeId: "osm:node:1", name: "Музей-квартира Александра Солженицына", address: null, tier: "auto", score: 95, category: "tourism:museum",
    reasons: [], signals: ["unique_name", "inside_address_building"], assessedAt: "2026-09-23T09:00:00Z", job: null,
    location: { status: "matched", building: { address: "Москва, Тверская улица, 12 с8", relation: "point_in_building" } } },
  { placeId: "osm:node:2", name: "В. И. Ленину", address: null, tier: "manual", score: 20, category: "historic:memorial",
    reasons: ["uninformative_name", "duplicate_name"], signals: ["specific_type"], assessedAt: "2026-09-23T09:00:00Z",
    job: { state: "review_required", identityPolicy: "weak_identity" }, location: { status: "matched", street: { name: "Тверская улица", distanceMeters: 30 }, district: "Тверской район" } },
];
const pilotBatch: ContentBatch = {
  id: "22222222-2222-4222-8222-222222222222", name: "Пилот weak_identity", state: "paused", mode: "text-only", textProfile: "story-v1",
  ttsProfile: null, identityPolicy: "weak_identity", createdAt: "2026-09-23T09:00:00Z", updatedAt: "2026-09-23T09:00:00Z",
  counts: { total: 5, queued: 5, working: 0, ready: 0, failed: 0 },
};

let root: Root;
let container: HTMLDivElement;
let requests: { path: string; body?: unknown }[];
let assessedAt: string | null;
let stale: number;
const onPilotCreated = vi.fn(async () => {});

const api: AdminApi = async <T,>(path: string, _signal: AbortSignal, body?: unknown): Promise<T> => {
  requests.push({ path, body });
  if (path === "/content/identity-candidates/pilot") return { batch: pilotBatch, created: true } as T;
  const tier = new URLSearchParams(path.split("?")[1]).get("tier");
  const items = candidates.filter(item => tier === "all" || item.tier === tier);
  const page: IdentityCandidatePage = { items, total: items.length, hasMore: false, tiers: { auto: 1, enrich: 0, manual: 1 },
    categories: [{ category: "tourism:museum", count: 1 }], stale, rulesVersion: "identity-triage-v1", assessedAt, pilotLimit: 50 };
  return page as T;
};

function Harness() {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const run: AdminRun = async (label, action) => {
    setBusy(label); setError("");
    try { await action(new AbortController().signal); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(""); }
  };
  return createElement("div", null, error && createElement("p", { role: "alert" }, error),
    createElement(IdentityCandidates, { api, run, busy, onPilotCreated }));
}

const button = (label: string) => [...container.querySelectorAll("button")].find(item => item.textContent?.includes(label))!;
const rowNames = () => [...container.querySelectorAll("tbody th")].map(cell => cell.firstChild?.textContent);
async function click(target: HTMLButtonElement) { await act(async () => { target.click(); }); }

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  requests = []; assessedAt = "2026-09-23T09:00:00Z"; stale = 0; onPilotCreated.mockClear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => { root.render(createElement(Harness)); });
});

afterEach(() => {
  act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe("IdentityCandidates", () => {
  it("loads nothing until the editor opens the block, then shows auto candidates with their explanation", async () => {
    expect(requests).toEqual([]);
    await click(button("Показать кандидатов"));
    expect(requests[0].path).toContain("tier=auto");
    expect(rowNames()).toEqual(["Музей-квартира Александра Солженицына"]);
    const row = container.querySelector("tbody tr")!;
    expect(row.textContent).toContain("Автогенерация");
    expect(row.textContent).toContain("Ограничений нет");
    expect(row.textContent).toContain("Точка OSM внутри здания: Москва, Тверская улица, 12 с8");
  });

  it("switches tiers and shows reasons and the existing job in Russian", async () => {
    await click(button("Показать кандидатов"));
    await click(button("только вручную"));
    expect(requests.at(-1)!.path).toContain("tier=manual");
    expect(rowNames()).toEqual(["В. И. Ленину"]);
    const row = container.querySelector("tbody tr")!;
    expect(row.textContent).toContain("Название из инициалов или слишком короткое; Такое же название у других мест");
    expect(row.textContent).toContain("Нужна редактура");
    expect(row.textContent).toContain("Тверская улица, Тверской район");
  });

  it("creates a paused pilot only after confirmation and refreshes the batches", async () => {
    await click(button("Показать кандидатов"));
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    await click(button("Создать пилот"));
    expect(requests.some(request => request.path.endsWith("/pilot"))).toBe(false);
    await click(button("Создать пилот"));
    expect(confirm).toHaveBeenCalledTimes(2);
    const pilot = requests.find(request => request.path.endsWith("/pilot"))!;
    expect(pilot.body).toMatchObject({ limit: 20, mode: "text-only" });
    expect(typeof (pilot.body as { requestKey: string }).requestKey).toBe("string");
    expect(onPilotCreated).toHaveBeenCalledWith(pilotBatch, expect.anything());
    expect(container.textContent).toContain("создан на паузе: 5 мест");
  });

  it("explains how to run the assessment when it has not been done", async () => {
    assessedAt = null;
    await click(button("Показать кандидатов"));
    expect(container.textContent).toContain("node scripts/assess-identity-candidates.mjs");
    expect(container.querySelector("table")).toBeNull();
  });

  it("warns about assessments made stale by a catalog update", async () => {
    stale = 12;
    await click(button("Показать кандидатов"));
    expect(container.textContent).toContain("12 оценок устарели");
  });
});
