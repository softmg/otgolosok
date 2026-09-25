import test from "node:test";
import assert from "node:assert/strict";
import { AUTO_SCORE, assessIdentityCandidate, identityNameKey, quoteNamesPlace, restrictWeakIdentityEvidence } from "./identity-triage.mjs";

const point = { lat: 55.75, lon: 37.61 };
const inside = { status: "matched", containingBuilding: { address: "Москва, Тверская улица, 12 с8", relation: "point_in_building" },
  nearbyAddresses: [{ address: "Москва, Тверская улица, 12 с8", distanceMeters: 0 }], street: { name: "Тверская улица", distanceMeters: 30 }, district: { name: "Тверской район" } };
const edge = { ...inside, containingBuilding: { ...inside.containingBuilding, relation: "point_on_boundary" } };
const streetOnly = { status: "matched", containingBuilding: null, nearbyAddresses: [{ address: "Москва, Тверская улица, 1", distanceMeters: 180 }],
  street: { name: "Тверская улица", distanceMeters: 40 }, district: { name: "Тверской район" } };
const polygon = { type: "Polygon", coordinates: [[[37.6, 55.7], [37.61, 55.7], [37.61, 55.71], [37.6, 55.7]]] };
const place = (name, tags = { tourism: "museum" }, extra = {}) => ({ name, location: point, tags: { name, ...tags }, address: null, ...extra });

test("tiers follow identity strength", () => {
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

test("quotes must name the object as OSM does", () => {
  const cases = [
    ["Сквер Бунина", "В сквере имени Бунина в 2010 году поставили памятник писателю.", true],
    ["Сквер Бунина", "Сквер у дома 5 на Поварской улице благоустроили в 2010 году.", false],
    ["Дом-музей и экспедиционный штаб Федора Конюхова", "Дом-музей Фёдора Конюхова открылся в Садовниках.", true],
    ["Дом-музей и экспедиционный штаб Федора Конюхова", "Дом-музей Юрия Никулина открылся на Бронной.", false],
    ["Архитекторам дома", "Доска посвящена архитекторам дома в Чистом переулке.", true],
    ["Ю. В. Никулину", "Мемориальная доска в честь клоуна появилась в 1998 году.", false],
    ["Ю. В. Никулину", "Мемориальная доска Ю. В. Никулину появилась в 1998 году.", true],
    // A full name: sources about a mural or plaque usually drop the patronymic.
    ["Василий Семёнович Лановой", "Черно-белый портрет Василия Ланового в роли генерала.", true],
    ["Василий Семёнович Лановой", "Новое граффити с Василием Лановым разделило жителей Таганки.", true],
    ["Василий Семёнович Лановой", "Имя при рождении Василий Семёнович Лановой.", true],
    ["Василий Семёнович Лановой", "Андрей Лановой, сын актёра, открыл выставку.", false],
    ["Василий Семёнович Лановой", "На стене появился портрет Ланового.", false],
    ["Мария Ивановна Ермолова", "Доска в честь актрисы Марии Ермоловой.", true],
    ["Мария Ивановна Ермолова", "Доска в честь актрисы Ермоловой.", false],
    // Not a full name: the capitalised words stay required.
    ["Дом бабочек муравьёв и рептилий", "Дом бабочек, муравьев и рептилий — выставочное пространство.", true],
    ["Храм Чуда Архистратига Михаила в Хонех", "Собор Чуда Архангела Михаила находится под зданием 1932 года.", false],
  ];
  for (const [name, quote, expected] of cases) assert.equal(quoteNamesPlace(quote, { name, tags: { name } }), expected, `${name} / ${quote}`);
  assert.equal(quoteNamesPlace("Старое название — сад Эрмитаж.", { name: "Сад", tags: { name: "Сад", old_name: "Сад Эрмитаж" } }), true);
});

test("weak identity evidence keeps only object facts and requires a naming identity quote", () => {
  const target = { name: "Сквер Бунина", tags: { name: "Сквер Бунина" } };
  const fact = (id, kind, subjectRelation, quote, sourceId = "s1") => ({ id, claim: `Факт ${id}`, kind, subjectRelation, evidence: [{ sourceId, quote }] });
  const evidence = { placeName: "Сквер Бунина", facts: [
    fact("f1", "identity", "object", "Сквер имени Бунина расположен на Поварской."),
    fact("f2", "content", "object", "Сквер назвали в честь писателя в 2010 году."),
    fact("f3", "content", "nearby", "Рядом стоит усадьба Долгоруковых.", "s2"),
  ], sources: [{ id: "s1" }, { id: "s2" }] };
  const restricted = restrictWeakIdentityEvidence(evidence, target);
  assert.deepEqual(restricted.facts.map(item => item.id), ["f1", "f2"]);
  assert.deepEqual(restricted.sources, [{ id: "s1" }]);
  assert.equal(restricted.identityPolicy, "weak_identity");
  assert.throws(() => restrictWeakIdentityEvidence({ ...evidence, facts: evidence.facts.slice(1) }, target), { code: "IDENTITY_UNCONFIRMED" });
  assert.throws(() => restrictWeakIdentityEvidence({ ...evidence, facts: [evidence.facts[0], evidence.facts[2]] }, target), { code: "INSUFFICIENT_EVIDENCE" });
  const nearbyIdentity = { ...evidence, facts: [{ ...evidence.facts[0], subjectRelation: "site_context" }, evidence.facts[1]] };
  assert.throws(() => restrictWeakIdentityEvidence(nearbyIdentity, target), { code: "IDENTITY_UNCONFIRMED" });
});
