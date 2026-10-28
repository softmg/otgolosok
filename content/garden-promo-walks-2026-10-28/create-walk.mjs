// node create-walk.mjs plan <walk> <walk-doc.json>    — route through the production pedestrian router, write the document
// node create-walk.mjs create <walk> <walk-doc.json>  — save the reviewed document as a link-only walk of `promo-walks`
// node create-walk.mjs update <walk> <walk-doc.json> <revision> — replace the saved walk's document, guarded by its revision
// <walk> is a key of WALKS; stops come from walk-stops-<walk>.json next to this script.
// Runs inside the generator container. `create` is idempotent: a rerun with the same document returns the saved walk.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const backend = process.env.BACKEND_DIR ?? "/app/backend";
const load = (file) => import(pathToFileURL(join(backend, file)).href);
const here = dirname(fileURLToPath(import.meta.url));

const WALKS = {
  "ivanovskaya-gorka": {
    idempotencyKey: "ivanovskaya-gorka-walk-2026-10-28",
    id: "dc9fb6c4-506b-4d77-9f8e-b65c6849f80c",
    title: "Ивановская горка: палаты, общины и Хохловка",
    description: (count) => `${count} остановок по кругу от метро «Китай-город»: Политехнический музей и Маросейка, палаты Мазепы и Шуйских, лютеранский собор, Хоральная синагога, храм Троицы в Хохлах и дом с атлантами на Солянке. Рассказы слушаются снаружи, вход в музеи и храмы не требуется. Следуйте по пешеходной линии на карте.`,
    start: { address: "Москва, метро «Китай-город»", location: { lat: 55.756498, lon: 37.631326 } },
    finish: { address: "Москва, метро «Китай-город»", location: { lat: 55.75436, lon: 37.633877 } },
    end: "метро «Китай-город»",
  },
  "bryusov-nikitskaya": {
    idempotencyKey: "bryusov-nikitskaya-walk-2026-10-28",
    id: "0a73ba97-6d5b-4fe7-a7c3-63a4d1ed010b",
    title: "Брюсов переулок и Большая Никитская: музыка и сцена",
    description: (count) => `${count} остановок от метро «Арбатская» до метро «Чеховская»: консерватория и Чайковский, Брюсов переулок с квартирами Мейерхольда и Голованова, памятник Хачатуряну, дом-музей Станиславского, Пушкинский дуб и Тверская площадь. Рассказы слушаются снаружи, вход в музеи не требуется. Следуйте по пешеходной линии на карте.`,
    start: { address: "Москва, метро «Арбатская»", location: { lat: 55.752312, lon: 37.60349 } },
    finish: { address: "Москва, метро «Чеховская»", location: { lat: 55.765747, lon: 37.608493 } },
    end: "метро «Чеховская»",
  },
  "tatarskaya-sloboda": {
    idempotencyKey: "tatarskaya-sloboda-walk-2026-10-28",
    id: "21cbf5b6-78ca-415f-bb16-23a00bbecb08",
    title: "Татарская слобода: мечеть, храмы и типография",
    description: (count) => `${count} остановок от метро «Павелецкая» до метро «Добрынинская»: музей Фёдора Конюхова, старообрядческий собор Покрова, Историческая мечеть и памятник Тукаю, храмы Кузнецкой слободы и Вишняков, особняк Рекк и типография Сытина. Рассказы слушаются снаружи, вход в храмы и музеи не требуется. Следуйте по пешеходной линии на карте.`,
    start: { address: "Москва, метро «Павелецкая»", location: { lat: 55.731414, lon: 37.636294 } },
    finish: { address: "Москва, метро «Добрынинская»", location: { lat: 55.728994, lon: 37.622533 } },
    end: "метро «Добрынинская»",
  },
  "ogorodnaya-sloboda": {
    idempotencyKey: "ogorodnaya-sloboda-walk-2026-10-28",
    id: "3e35af1d-1b71-47c4-9eb0-726019fbd358",
    title: "Огородная слобода и Кривоколенный: палаты и театр",
    description: (count) => `${count} остановок от метро «Красные Ворота» до метро «Сретенский бульвар»: палаты Волковых — Юсуповых, где в детстве жил Пушкин, Огородная слобода, палаты Сверчковых и Голицыных, театр «Et Cetera», Тургеневская читальня и храм Успения в Печатниках. Рассказы слушаются снаружи. Следуйте по пешеходной линии на карте.`,
    start: { address: "Москва, метро «Красные Ворота»", location: { lat: 55.768307, lon: 37.6478 } },
    finish: { address: "Москва, метро «Сретенский бульвар»", location: { lat: 55.766106, lon: 37.635688 } },
    end: "метро «Сретенский бульвар»",
  },
};

const distance = (a, b) => {
  const t = Math.PI / 180, x = Math.sin((b.lat - a.lat) * t / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin((b.lon - a.lon) * t / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(x));
};

const [mode, key, ...paths] = process.argv.slice(2);
const walk = WALKS[key];
assert.ok(walk, `Прогулка: ${Object.keys(WALKS).join(", ")}`);

const openAccounts = async () => {
  const { createAccountStore } = await load("account-store.mjs");
  const { PROMO_WALKS_USER_ID } = await load("promo-walks.mjs");
  const db = new DatabaseSync(process.env.AUTH_DATABASE_PATH ?? "/data/auth.sqlite", { timeout: 5000 });
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON");
  return { db, accounts: createAccountStore(db), owner: PROMO_WALKS_USER_ID };
};
const readDocument = async (docPath) => {
  const { validateWalkDocument } = await load("walk-document.mjs");
  const document = validateWalkDocument(JSON.parse(readFileSync(docPath, "utf8")));
  assert.equal(document.id, walk.id);
  return document;
};

if (mode === "plan") {
  const [outPath] = paths;
  const { createWalkPlanner } = await load("walks.mjs");
  const { planToWalkDocument } = await load("walk-plan-document.mjs");
  const { validateWalkDocument } = await load("walk-document.mjs");
  const stops = JSON.parse(readFileSync(join(here, `walk-stops-${key}.json`), "utf8"));
  const input = { start: walk.start, destination: walk.finish, mode: "open", minutes: 90,
    stops: stops.map(({ address, location, placeId }) => ({ address, location, placeId, contentId: placeId })) };
  const plan = await createWalkPlanner({ timeoutMs: 60000 })(input, { client: null });
  const document = planToWalkDocument(plan, { id: walk.id, title: walk.title, description: walk.description(stops.length), mode: "open", minutes: 90, start: walk.start });
  document.destination = walk.finish;
  document.stops.forEach((stop, index) => {
    // The listener stands on the drawn line, at its point nearest to the object.
    stop.triggerLocation = document.route.geometry.reduce((best, point) => distance(point, stop.place.location) < distance(best, stop.place.location) ? point : best);
    const next = stops[index + 1];
    stop.nextHint = next ? `Следующая остановка — ${next.label}. Следуйте по пешеходной линии на карте.` : `Дальше — ${walk.end}, конец прогулки. Следуйте по пешеходной линии на карте.`;
    assert.equal(stop.placeId, stops[index].placeId, "Планировщик изменил порядок остановок");
  });
  validateWalkDocument(document);
  writeFileSync(outPath, JSON.stringify(document, null, 2) + "\n");
  console.log(JSON.stringify({ distanceM: document.route.distanceM, walkingMinutes: document.route.walkingMinutes, stops: document.stops.length,
    triggers: document.stops.map((stop) => Math.round(distance(stop.triggerLocation, stop.place.location))) }));
} else if (mode === "create") {
  const document = await readDocument(paths[0]);
  const { db, accounts, owner } = await openAccounts();
  try {
    const saved = accounts.createWalk(owner, { title: document.title, snapshot: document, idempotencyKey: walk.idempotencyKey }, { maxWalks: Infinity });
    // Link-only until the owner queues it for promo: no catalog listing yet.
    const shared = saved.visibility === "shared" ? saved : accounts.setWalkVisibility(owner, saved.id, saved.revision, "shared");
    console.log(JSON.stringify({ id: shared.id, title: shared.title, revision: shared.revision, visibility: shared.visibility, shareToken: shared.shareToken }));
  } finally {
    db.close();
  }
} else if (mode === "update") {
  const document = await readDocument(paths[0]);
  const { db, accounts, owner } = await openAccounts();
  try {
    const saved = accounts.updateWalk(owner, walk.id, { title: document.title, snapshot: document, revision: Number(paths[1]) });
    assert.ok(saved, "Прогулка не найдена");
    console.log(JSON.stringify({ id: saved.id, title: saved.title, revision: saved.revision, visibility: saved.visibility, shareToken: saved.shareToken }));
  } finally {
    db.close();
  }
} else {
  throw new Error("Режим: plan, create или update");
}
