import { describe, expect, it } from "vitest";
import type { WalkDocument } from "./model";
import type { LocalWalkItem } from "./local-store";
import { formatFinish, formatStartDistance, localNearbyWalks, mergeNearby, nearbyWalkHref, NEARBY_RADIUS_M, validateNearbyWalks, type NearbyWalk } from "./nearby-model";

const TOKEN = "22222222-2222-4222-8222-222222222222", OWN = "33333333-3333-4333-8333-333333333333";
const card = { title: "Арбат", walkingMinutes: 45, distanceM: 3200, stopCount: 2, rating: { average: null, count: 0 }, startDistanceM: 350, finish: "Москва, Арбат, 20" };
const catalog = { ...card, kind: "catalog", id: "msk-walk" };
const shared = { ...card, kind: "shared", id: TOKEN };
const own = { ...card, kind: "own", id: OWN };

describe("ответ подборки рядом", () => {
  it("принимает каталожные, открытые и свои прогулки", () => {
    expect(validateNearbyWalks({ walks: [catalog, shared, own] })).toEqual([catalog, shared, own]);
  });

  it("принимает кольцевую прогулку без финиша", () => {
    expect(validateNearbyWalks({ walks: [{ ...catalog, finish: null }] })[0].finish).toBeNull();
  });

  it.each([
    ["локальная прогулка с сервера", { walks: [{ ...own, kind: "local" }] }],
    ["неизвестный вид", { walks: [{ ...own, kind: "account" }] }],
    ["слаг у своей прогулки", { walks: [{ ...own, id: "msk-walk" }] }],
    ["токен не UUID", { walks: [{ ...shared, id: "token" }] }],
    ["нет расстояния до старта", { walks: [{ ...catalog, startDistanceM: undefined }] }],
    ["отрицательное расстояние", { walks: [{ ...catalog, startDistanceM: -50 }] }],
    ["дробное расстояние", { walks: [{ ...catalog, startDistanceM: 12.5 }] }],
    ["нет названия", { walks: [{ ...catalog, title: "" }] }],
    ["нет списка", { walks: null }],
    ["нет финиша", { walks: [{ ...catalog, finish: undefined }] }],
    ["пустой финиш", { walks: [{ ...catalog, finish: " " }] }],
    ["финиш не строка", { walks: [{ ...catalog, finish: 5 }] }],
  ])("отклоняет: %s", (_name, value) => {
    expect(() => validateNearbyWalks(value)).toThrow(TypeError);
  });
});

it.each([
  [{ kind: "catalog", id: "msk-walk" }, "/walk?catalog=msk-walk"],
  [{ kind: "shared", id: TOKEN }, `/walk?share=${TOKEN}`],
  [{ kind: "own", id: OWN }, `/walk?id=${OWN}`],
  [{ kind: "local", id: "a b" }, "/walk?local=a%20b"],
] as const)("ссылка на прогулку %o", (walk, href) => {
  expect(nearbyWalkHref(walk)).toBe(href);
});

it.each([
  ["Москва, Садовническая улица, 5", "до Садовническая улица, 5"],
  ["Зарядье", "до Зарядье"],
  [null, "по кругу, обратно к старту"],
])("финиш %s", (finish, text) => {
  expect(formatFinish(finish)).toBe(text);
});

it.each([[0, "старт рядом"], [49, "старт рядом"], [50, "старт в 50 м"], [374, "старт в 350 м"], [500, "старт в 500 м"]])("расстояние до старта %i м", (meters, text) => {
  expect(formatStartDistance(meters)).toBe(text);
});

it.each([[0, "рядом с вами"], [49, "рядом с вами"], [50, "в 50 м от вас"], [376, "в 400 м от вас"]])("расстояние от пользователя %i м", (meters, text) => {
  expect(formatStartDistance(meters, "you")).toBe(text);
});

// Meters per degree of latitude on the haversine sphere.
const M_PER_LAT = 6_371_000 * Math.PI / 180;
const START = { lat: 55.75, lon: 37.6 };
const local = (id: string, meters: number, updatedAt: string, { route = true, loop = false } = {}): LocalWalkItem => {
  const location = { lat: START.lat + meters / M_PER_LAT, lon: START.lon }, stop = { lat: location.lat + 0.001, lon: location.lon };
  const document = { version: 2, id, title: `Прогулка ${id}`, description: "", city: "Москва", mode: loop ? "loop" : "open", minutes: 30,
    start: { address: "Москва, Арбат, 1", location }, stops: [{ id: `${id}-stop`, place: { address: "Москва, Арбат, 2", location: stop }, storyRef: null, transition: "", nextHint: "" }],
    route: route ? { geometry: [location, stop], distanceM: 1200, walkingMinutes: 15, attribution: "OSM" } : null, fieldChecked: false } as WalkDocument;
  return { document, revision: 0, updatedAt };
};

describe("локальные прогулки рядом", () => {
  it("оставляет построенные прогулки в радиусе, новые первыми", () => {
    const walks = localNearbyWalks([
      local("old", 100, "2026-10-01T00:00:00.000Z"),
      local("new", 200, "2026-10-05T00:00:00.000Z"),
      local("far", NEARBY_RADIUS_M + 1, "2026-10-06T00:00:00.000Z"),
      local("draft", 10, "2026-10-06T00:00:00.000Z", { route: false }),
      local("edge", NEARBY_RADIUS_M - 1, "2026-10-02T00:00:00.000Z"),
    ], START, null);
    expect(walks.map(walk => walk.id)).toEqual(["new", "edge", "old"]);
    expect(walks[0]).toEqual({ kind: "local", id: "new", title: "Прогулка new", walkingMinutes: 15, distanceM: 1200, stopCount: 1, rating: { average: null, count: 0 }, startDistanceM: 200, finish: "Москва, Арбат, 2" });
  });

  it("у кольцевой прогулки нет финиша", () => {
    expect(localNearbyWalks([local("loop", 10, "", { loop: true })], START, null)[0].finish).toBeNull();
  });

  it("не предлагает открытую в конструкторе прогулку", () => {
    expect(localNearbyWalks([local("open", 10, ""), local("other", 20, "")], START, "open").map(walk => walk.id)).toEqual(["other"]);
  });
});

describe("слияние подборки", () => {
  const server = [catalog, shared, own] as NearbyWalk[];
  const mine = ["l1", "l2", "l3"].map(id => ({ ...card, kind: "local", id })) as NearbyWalk[];
  it.each([
    ["серверные первыми, лимит 5", server, mine, null, ["msk-walk", TOKEN, OWN, "l1", "l2"]],
    ["локальные занимают свободные места", [catalog] as NearbyWalk[], mine, null, ["msk-walk", "l1", "l2", "l3"]],
    ["открытая своя прогулка не предлагается", server, mine, { kind: "account", id: OWN.toUpperCase() }, ["msk-walk", TOKEN, "l1", "l2", "l3"]],
    ["локальное исключение не трогает серверные", server, mine, { kind: "local", id: OWN }, ["msk-walk", TOKEN, OWN, "l1", "l2"]],
    ["пусто", [], [], null, []],
  ] as const)("%s", (_name, serverWalks, localWalks, exclude, ids) => {
    expect(mergeNearby([...serverWalks], [...localWalks], exclude).map(walk => walk.id)).toEqual(ids);
  });
});
