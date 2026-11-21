// node create-walk.mjs plan <walk> <walk-doc.json>    — route through the production pedestrian router, write the document
// node create-walk.mjs create <walk> <walk-doc.json>  — save the reviewed document as a link-only walk of `promo-walks`
// node create-walk.mjs update <walk> <walk-doc.json> <revision> — replace the saved walk's document, guarded by its revision
// <walk> is `teatralnaya` or `vdnh`; stops come from walk-stops-<walk>.json next to this script.
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
  teatralnaya: {
    idempotencyKey: "teatralnaya-walk-2026-10-17",
    id: "71879bf2-de7c-4be4-9834-6f7f410f80d2",
    title: "Театральная и Кузнецкий мост: сцены, бани и банки",
    description: (count) => `${count} остановок от метро «Театральная» до метро «Цветной бульвар»: Малый и Большой театры, Кузнецкий Мост и Рождественка, Сандуновские бани и Неглинная, Большая Дмитровка и Петровка. Рассказы слушаются снаружи, вход в театры и музеи не требуется. Следуйте по пешеходной линии на карте.`,
    start: { address: "Москва, метро «Театральная»", location: { lat: 55.758808, lon: 37.61768 } },
    finish: { address: "Москва, метро «Цветной бульвар»", location: { lat: 55.771653, lon: 37.620466 } },
    end: "метро «Цветной бульвар»",
  },
  vdnh: {
    idempotencyKey: "vdnh-walk-2026-10-17",
    id: "c800b3e2-69ff-483a-9b84-fb2aea4722f9",
    title: "ВДНХ: павильоны республик и космос",
    description: (count) => `${count} остановок от метро «ВДНХ» до метро «Ботанический сад»: монумент «Покорителям космоса», арка Главного входа, Главный павильон и павильоны союзных республик вокруг фонтана «Дружба народов», «Зерно», «Транспорт» и «Микробиологическая промышленность». Рассказы слушаются снаружи, вход в павильоны не требуется. Следуйте по пешеходной линии на карте.`,
    start: { address: "Москва, метро «ВДНХ»", location: { lat: 55.819626, lon: 37.640751 } },
    finish: { address: "Москва, метро «Ботанический сад»", location: { lat: 55.844597, lon: 37.637811 } },
    end: "метро «Ботанический сад»",
  },
};

const distance = (a, b) => {
  const t = Math.PI / 180, x = Math.sin((b.lat - a.lat) * t / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin((b.lon - a.lon) * t / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(x));
};

const [mode, key, ...paths] = process.argv.slice(2);
const walk = WALKS[key];
assert.ok(walk, "Прогулка: teatralnaya или vdnh");

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
