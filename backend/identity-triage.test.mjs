import test from "node:test";
import assert from "node:assert/strict";
import { AUTO_SCORE, assessIdentityCandidate, identityNameKey, restrictWeakIdentityEvidence } from "./identity-triage.mjs";

const point = { lat: 55.75, lon: 37.61 };
const inside = { status: "matched", containingBuilding: { address: "Москва, Тверская улица, 12 с8", relation: "point_in_building" },
  nearbyAddresses: [{ address: "Москва, Тверская улица, 12 с8", distanceMeters: 0 }], street: { name: "Тверская улица", distanceMeters: 30 }, district: { name: "Тверской район" } };
const edge = { ...inside, containingBuilding: { ...inside.containingBuilding, relation: "point_on_boundary" } };
const streetOnly = { status: "matched", containingBuilding: null, nearbyAddresses: [{ address: "Москва, Тверская улица, 1", distanceMeters: 180 }],
  street: { name: "Тверская улица", distanceMeters: 40 }, district: { name: "Тверской район" } };
const polygon = { type: "Polygon", coordinates: [[[37.6, 55.7], [37.61, 55.7], [37.61, 55.71], [37.6, 55.7]]] };
/** @param {string} name @param {Record<string, string>} [tags] @param {object} [extra] */
const place = (name, tags = { tourism: "museum" }, extra = {}) => ({ name, location: point, tags: { name, ...tags }, address: null, ...extra });

test("tiers follow identity strength", () => {
  /** @type {Array<[string, any, any, string]>} */
  const cases = [
    ["unique museum inside an addressed building", place("Музей-квартира Александра Солженицына"), { locationContext: inside }, "auto"],
    ["named plaque on a building edge", place("Василий Прокофьевич Ефанов", { historic: "memorial" }), { locationContext: edge }, "auto"],
    ["typed park polygon with district", place("Сквер Бунина", { leisure: "park" }, { geometry: polygon }), { locationContext: streetOnly }, "auto"],
    ["museum without an address anchor", place("Дом-музей Зураба Церетели"), { locationContext: streetOnly }, "enrich"],
    ["unique single-word artwork", place("Сфинкс", { tourism: "artwork" }), { locationContext: inside }, "enrich"],
    ["namesake with a long name", place("Воинам-победителям в Великой Отечественной войне", { historic: "memorial" }), { locationContext: inside, nameCount: 3 }, "enrich"],
    ["initials on an addressed building", place("Ю. В. Никулину", { historic: "memorial" }), { locationContext: edge }, "enrich"],
    ["initials without an anchor", place("В. И. Ленину", { historic: "memorial" }), { locationContext: streetOnly }, "manual"],
    ["repeated one-word artwork", place("Бобёр", { tourism: "artwork" }), { locationContext: inside, nameCount: 3 }, "manual"],
    ["street name on a memorial plaque", place("Петровский переулок", { historic: "memorial" }), { locationContext: edge }, "manual"],
    ["no specific type", place("Старинный дом купца Иванова", {}), { locationContext: inside }, "manual"],
    ["no location context at all", place("Мемориал памяти защитников Белого дома 1993 года", { historic: "memorial" }), { locationContext: { status: "unmatched" } }, "enrich"],
  ];
  for (const [label, input, options, tier] of cases) {
    const result = assessIdentityCandidate(input, options);
    assert.equal(result?.tier, tier, `${label}: ${JSON.stringify(result)}`);
    assert.ok(result.score >= 0 && result.score <= 100, label);
  }
});

test("auto requires the score threshold and records explainable signals", () => {
  const result = assessIdentityCandidate(place("Музей-квартира Александра Солженицына"), { locationContext: inside });
  assert.ok(result.score >= AUTO_SCORE);
  assert.deepEqual(result.reasons, []);
  for (const signal of ["informative_name", "specific_type", "typed_name", "distinctive_name", "unique_name", "inside_address_building", "street_100m", "district"])
    assert.ok(result.signals.includes(signal), signal);
  assert.equal(result.category, "tourism:museum");
  assert.deepEqual(result.location.building, { address: "Москва, Тверская улица, 12 с8", relation: "point_in_building" });
  const namesake = assessIdentityCandidate(place("Музей-квартира Александра Солженицына"), { locationContext: inside, nameCount: 2 });
  assert.equal(namesake.tier, "enrich");
  assert.ok(namesake.reasons.includes("duplicate_name"));
  assert.equal(namesake.score, result.score - 35);
});

test("a building around the representative point of an area object is not an address anchor", () => {
  const park = assessIdentityCandidate(place("Сквер «5 деревень»", { leisure: "park" }, { geometry: polygon }), { locationContext: edge });
  assert.equal(park.tier, "auto", "the typed polygon with a district is still anchored");
  assert.ok(!park.signals.includes("on_address_building_edge"));
  assert.ok(park.reasons.includes("no_address_anchor"));
  assert.ok(park.score < 100);
  const unnamedArea = assessIdentityCandidate(place("Красная руина", { tourism: "attraction" }, { geometry: polygon }), { locationContext: inside });
  assert.equal(unnamedArea.tier, "enrich");
});

test("eligible places and places without coordinates are not triage candidates", () => {
  assert.equal(assessIdentityCandidate(place("Музей", { tourism: "museum", wikidata: "Q1" }), { locationContext: inside }), null);
  assert.equal(assessIdentityCandidate({ ...place("Музей-квартира Александра Солженицына"), location: null }, { locationContext: inside }), null);
  const unavailable = assessIdentityCandidate(place("Музей-квартира Александра Солженицына"), {});
  assert.deepEqual(unavailable.location, { status: "unavailable" });
  assert.ok(unavailable.reasons.includes("no_location_context"));
});

test("name keys fold case, ё and quotes so namesakes are counted together", () => {
  assert.equal(identityNameKey(" Обелиск «Памяти павших» "), identityNameKey("обелиск \"памяти павших\""));
  assert.equal(identityNameKey("Бобёр"), identityNameKey("БОБЕР"));
});

test("weak identity evidence keeps object facts and requires useful content", () => {
  const fact = (id, kind, subjectRelation, quote, sourceId = "s1") => ({ id, claim: `Факт ${id}`, kind, subjectRelation, evidence: [{ sourceId, quote }] });
  const evidence = { placeName: "Сквер Бунина", facts: [
    fact("f1", "identity", "object", "Сквер имени Бунина расположен на Поварской."),
    fact("f2", "content", "object", "Сквер назвали в честь писателя в 2010 году."),
    fact("f3", "content", "nearby", "Рядом стоит усадьба Долгоруковых.", "s2"),
  ], sources: [{ id: "s1" }, { id: "s2" }] };
  const restricted = restrictWeakIdentityEvidence(evidence);
  assert.deepEqual(restricted.facts.map(item => item.id), ["f1", "f2"]);
  assert.deepEqual(restricted.sources, [{ id: "s1" }]);
  assert.equal(restricted.identityPolicy, "weak_identity");
  assert.deepEqual(restrictWeakIdentityEvidence({ ...evidence, facts: evidence.facts.slice(1) }).facts, [evidence.facts[1]]);
  assert.throws(() => restrictWeakIdentityEvidence({ ...evidence, facts: [evidence.facts[0], evidence.facts[2]] }), { code: "INSUFFICIENT_EVIDENCE" });
  const nearbyIdentity = { ...evidence, facts: [{ ...evidence.facts[0], subjectRelation: "site_context" }, evidence.facts[1]] };
  assert.deepEqual(restrictWeakIdentityEvidence(nearbyIdentity).facts, [evidence.facts[1]]);
});

test("declined and descriptive source names do not veto an identified object", () => {
  for (const [name, quote] of [
    ["Пещерный лев", "Скульптура Пещерного льва Panthera leo spelaea на палеотропе Дарвиновского музея."],
    ["Живые павшим обязаны вечно", "Мемориальная доска памяти павших сотрудников кондитерской фабрики Красный Октябрь."],
    ["Парк усадьбы Старо-Никольское", "Усадьба открыта для посетителей, благоустроен парк вокруг главного здания."],
  ]) {
    const evidence = { placeName: name, sources: [{ id: "s1" }], facts: [
      { id: "f1", kind: "identity", subjectRelation: "object", evidence: [{ sourceId: "s1", quote }] },
      { id: "f2", kind: "content", subjectRelation: "object", evidence: [{ sourceId: "s1", quote }] },
    ] };
    const result = restrictWeakIdentityEvidence(evidence);
    assert.deepEqual(result.facts, evidence.facts, name);
    assert.deepEqual(result.sources, evidence.sources, name);
  }
});
