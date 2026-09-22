import test from "node:test";
import assert from "node:assert/strict";
import { researchPrompt, factsPrompt } from "./prompts.mjs";
import { enrichOsmContext, osmPostalAddress } from "./osm-context.mjs";

function contextOf(prompt) {
  return JSON.parse(prompt.match(/^OSM PLACE CONTEXT[^:]*: (.+)$/m)[1]);
}

test("research expands an abbreviated memorial name and retains a street without a house number", () => {
  const place = { name: "Г. Галилею", postalAddress: null, location: { lat: 55.75, lon: 37.61 },
    tags: { historic: "memorial", "addr:street": "улица Примерная", "subject:wikidata": "Q307" } };
  const context = contextOf(researchPrompt(null, place));
  assert.equal(context.name, "Г. Галилею");
  assert.equal(context.postalAddress, null);
  assert.equal(context.locationHint, "Москва, улица Примерная");
  assert.ok(context.searchQueries.includes("Памятник Г. Галилею Москва, улица Примерная"));
  assert.ok(context.searchQueries.includes("Мемориальная доска Г. Галилею Москва, улица Примерная"));
  assert.equal(context.objectType, "Мемориальный объект");
  assert.deepEqual(context.subjectIdentifiers, { wikidata: "Q307" });
  assert.deepEqual(context.objectIdentifiers, {});
  assert.deepEqual(contextOf(factsPrompt(null, [], place)), context);
});

test("specific OSM types produce search names without expanding initials or guessing subtypes", () => {
  for (const [name, tags, expected] of [
    ["Г. Галилею", { historic: "memorial", memorial: "bust" }, "Бюст Г. Галилею"],
    ["Композиция №1", { tourism: "artwork", artwork_type: "sculpture" }, "Скульптура Композиция №1"],
    ["аппарат «Аргус»", { tourism: "artwork" }, "Арт-объект аппарат «Аргус»"],
    ["Памятник Галилею", { historic: "monument" }, "Памятник Галилею"],
    ["сквер на набережной Шитова", { leisure: "park" }, "сквер на набережной Шитова"],
    ["Непонятное название", { memorial: "unknown" }, "Непонятное название"],
  ]) {
    const context = contextOf(researchPrompt(null, { name, tags }));
    assert.equal(context.searchName, expected);
    assert.ok(context.searchQueries.includes(`${expected} Москва`));
    assert.equal(context.postalAddress, null);
  }
});

test("search uses alternate names, full address and object identifiers separately from the subject", () => {
  const context = contextOf(researchPrompt(null, { name: "Г. Галилею", tags: {
    historic: "memorial", memorial: "statue", "addr:city": "Москва", "addr:street": "Примерная улица",
    "addr:housenumber": "12", alt_name: "Галилео Галилею;Галилей", wikidata: "Q123", "subject:wikidata": "Q307",
  } }));
  assert.equal(context.postalAddress, "Москва, Примерная улица, 12");
  assert.ok(context.searchQueries.includes("Памятник Галилео Галилею Москва, Примерная улица, 12"));
  assert.deepEqual(context.objectIdentifiers, { wikidata: "Q123" });
  assert.deepEqual(context.subjectIdentifiers, { wikidata: "Q307" });
});

test("missing or partial address never invents a street or a house number", () => {
  assert.equal(osmPostalAddress(null), null);
  for (const [tags, hint, address] of [
    [{}, "Москва", null],
    [{ "addr:housenumber": "7" }, "Москва", null],
    [{ "addr:place": "территория музея" }, "Москва, территория музея", null],
    [{ "addr:full": "Москва, Арбат, 1" }, "Москва, Арбат, 1", "Москва, Арбат, 1"],
  ]) {
    const context = contextOf(researchPrompt(null, { name: "Объект", tags }));
    assert.equal(context.locationHint, hint);
    assert.equal(context.postalAddress, address);
  }
  assert.doesNotMatch(researchPrompt("Москва, Арбат, 1"), /OSM PLACE CONTEXT/);
});

test("nearby OSM addresses are bounded search landmarks, never the object's address", () => {
  const place = { id: "osm:node:1", name: "Г. Галилею", location: { lat: 55.75, lon: 37.61 }, tags: { historic: "memorial" } };
  const element = (id, lat, street) => ({ type: "node", id, center: { lat, lon: 37.61 }, tags: { "addr:street": street, "addr:housenumber": "1" } });
  const context = enrichOsmContext(place, { nearbyElements: [
    element(1, 55.75, "Сам объект"), element(2, 55.7505, "Ближняя улица"),
    element(3, 55.7506, "Ближняя улица"), element(4, 55.751, "Вторая улица"),
    element(5, 55.752, "Третья улица"), element(6, 55.76, "Дальняя улица"),
    element(7, NaN, "Некорректная точка"),
  ] });
  assert.equal(context.postalAddress, null);
  assert.deepEqual(context.nearbyLandmarks.map(item => item.address), ["Москва, Ближняя улица, 1", "Москва, Вторая улица, 1"]);
  assert.ok(context.nearbyLandmarks.every(item => item.distanceMeters > 0 && item.distanceMeters <= 300));
  assert.ok(context.searchQueries.includes("Памятник Г. Галилею Москва, рядом с Москва, Ближняя улица, 1"));
  assert.deepEqual(enrichOsmContext({ name: "Без координат" }, { nearbyElements: [element(2, 55.75, "Улица")] }).nearbyLandmarks, []);
});

test("offline geocoding adds street, district and host-building search hints while retaining the missing postal address", () => {
  const locationContext={version:1,status:"matched",source:{source:"full-osm",sourceSha256:"b".repeat(64)},
    containingBuilding:{osmId:"osm:way:7",address:"Москва, Новая улица, 5",distanceMeters:0,relation:"point_in_building"},
    nearbyAddresses:[],street:{name:"Новая улица"},district:{name:"Тестовый район"}};
  const place={id:"osm:node:1",name:"А. Блоку",tags:{historic:"memorial"},locationContext};
  const context=enrichOsmContext(place,{nearbyElements:[]});
  assert.equal(context.postalAddress,null);
  assert.match(context.locationHint,/Новая улица/);
  assert.match(context.locationHint,/Тестовый район/);
  assert.ok(context.searchQueries.some(query=>query.includes("Новая улица, 5")));
  assert.equal(context.nearbyLandmarksSource.sourceSha256,"b".repeat(64));
  const partial=enrichOsmContext({...place,tags:{...place.tags,"addr:street":"Новая улица"}},{nearbyElements:[]});
  assert.equal(partial.postalAddress,null);
  assert.ok(partial.searchQueries.some(query=>query.includes("Новая улица, 5")));
  const existing=enrichOsmContext({...place,postalAddress:"Москва, Своя улица, 2"},{nearbyElements:[]});
  assert.equal(existing.locationHint,"Москва, Своя улица, 2");
});
