// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useWalkDraft } from "./use-walk-draft";
import { emptyDraft } from "./model";
import { RejectedRequest } from "./request";
import { draftToWalkDocument } from "../walks/adapters";

const mocks = vi.hoisted(() => ({ push: vi.fn(), request: vi.fn(), accountApi: vi.fn(), getSession: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push, replace: () => {} }) }));
vi.mock("../auth/client", () => ({ getSession: mocks.getSession, accountApi: mocks.accountApi }));
vi.mock("./request", async importOriginal => ({ ...await importOriginal<object>(), request: mocks.request }));

const walkId = "11111111-1111-4111-8111-111111111111";
const start = { address: "Москва, Арбат, 1", location: { lat: 55.75, lon: 37.6 } };
const stop = { address: "Москва, Арбат, 20", location: { lat: 55.752, lon: 37.6 } };
const plan = { stops: [stop], geometry: [start.location, stop.location, start.location], walkingMinutes: 25, distanceM: 1800, attribution: "OSM" };
const accountSnapshot = draftToWalkDocument({ ...emptyDraft(), title: "Маршрут в аккаунте", start, stops: [stop], route: plan }, walkId);

let hook: ReturnType<typeof useWalkDraft>;
let unmount: () => Promise<void>;
async function open(url: string) {
  history.replaceState(null, "", url);
  function Harness() { hook = useWalkDraft(); return null; }
  const root = createRoot(document.createElement("div"));
  await act(async () => { root.render(createElement(Harness)); });
  unmount = () => act(async () => { root.unmount(); });
}
const patches = () => mocks.accountApi.mock.calls.filter(([, init]) => init?.method === "PATCH");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.request.mockImplementation(async (url: string) => { if (url === "/api/walk-plan") return plan; throw new Error(`unexpected ${url}`); });
  mocks.getSession.mockResolvedValue(null);
});
afterEach(async () => { await unmount(); localStorage.clear(); history.replaceState(null, "", "/"); vi.clearAllMocks(); vi.unstubAllGlobals(); });

it("после построения открывает страницу прогулки на устройстве", async () => {
  await open("/?walk=create");
  await act(async () => { hook.edit({ start }); });
  await act(async () => { await hook.build(); });
  const id = localStorage.getItem("otgolosok:walk:active-local");
  expect(id).toBeTruthy();
  expect(mocks.push).toHaveBeenCalledExactlyOnceWith(`/walk?local=${id}`);
});

it("при ошибке построения остаётся в конструкторе с причиной", async () => {
  mocks.request.mockRejectedValue(new RejectedRequest("Сюда не дойти пешком. Выберите начало на улице рядом.", "WALK_START_UNREACHABLE", 404));
  await open("/?walk=create");
  await act(async () => { hook.edit({ start }); });
  await act(async () => { await hook.build(); });
  expect(mocks.push).not.toHaveBeenCalled();
  expect(hook.error).toBe("Сюда не дойти пешком. Выберите начало на улице рядом.");
});

// The walk page shows the server copy of an account walk, so a changed walk is saved before it opens.
it.each([
  ["неизменённая прогулка открывается без сохранения", false, null, 0, true, ""],
  ["перестроенная прогулка сохраняется и открывается", true, { visibility: "private", listingStatus: "none" }, 1, true, ""],
  ["публичная прогулка, ушедшая на проверку, остаётся в конструкторе", true, { visibility: "public", listingStatus: "pending" }, 1, false, "Прогулка сохранена. В топе она появится после проверки редакцией."],
  ["ошибка сохранения оставляет в конструкторе", true, "error", 1, false, ""],
] as const)("аккаунт: %s", async (_, rebuild, saved, patchCount, opened, message) => {
  mocks.getSession.mockResolvedValue({ id: "user" });
  mocks.accountApi.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method !== "PATCH") return { walk: { id: walkId, revision: 1, snapshot: accountSnapshot } };
    if (saved === "error") throw new Error("Сервис недоступен.");
    return { walk: { id: walkId, revision: 2, ...saved } };
  });
  await open(`/?walk=create&id=${walkId}&edit=1`);
  if (rebuild) {
    await act(async () => { hook.edit({ minutes: 60 }); });
    await act(async () => { await hook.build(); });
  } else await act(async () => { await hook.openWalk(); });
  expect(patches()).toHaveLength(patchCount);
  expect(mocks.push.mock.calls).toEqual(opened ? [[`/walk?id=${walkId}`]] : []);
  if (message) expect(hook.message).toBe(message);
  if (saved === "error") expect(hook.error).toBe("Сервис недоступен.");
});
