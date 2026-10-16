// node create-walk.mjs plan <stops.json> <walk-doc.json>   — route through the production pedestrian router, write the document
// node create-walk.mjs create <walk-doc.json>              — save the reviewed document as a link-only walk of `promo-walks`
// node create-walk.mjs update <walk-doc.json> <revision>   — replace the saved walk's document, guarded by its current revision
// Runs inside the generator container. `create` is idempotent: a rerun with the same document returns the saved walk.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const backend = process.env.BACKEND_DIR ?? "/app/backend";
const load = (file) => import(pathToFileURL(join(backend, file)).href);
const IDEMPOTENCY_KEY = "lefortovo-walk-2026-10-16";
// Stable document ID derived from the idempotency key, so a replanned rerun keeps the same walk identity.
const WALK_ID = "6f1c2a3e-4b5d-5e6f-8a7b-1c2d3e4f5a6b";
const TITLE = "Лефортово: дворцы, авиация и Елохово";
const description = (count) => `${count} остановок от метро «Бауманская» до метро «Лефортово»: Елоховский собор, Бауманское училище, улица Радио с первыми авиационными институтами, Екатерининский дворец и Лефортовский парк. Рассказы слушаются снаружи, вход в музеи и на территорию академии не требуется. Следуйте по пешеходной линии на карте.`;
const START = { address: "Москва, метро «Бауманская»", location: { lat: 55.772405, lon: 37.67904 } };
const FINISH = { address: "Москва, метро «Лефортово»", location: { lat: 55.764444, lon: 37.702778 } };

const distance = (a, b) => {
  const t = Math.PI / 180, x = Math.sin((b.lat - a.lat) * t / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin((b.lon - a.lon) * t / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(x));
};

const [mode, ...paths] = process.argv.slice(2);
if (mode === "plan") {
  const [stopsPath, outPath] = paths;
  const { createWalkPlanner } = await load("walks.mjs");
  const { planToWalkDocument } = await load("walk-plan-document.mjs");
  const { validateWalkDocument } = await load("walk-document.mjs");
  const stops = JSON.parse(readFileSync(stopsPath, "utf8"));
  const input = { start: START, destination: FINISH, mode: "open", minutes: 90,
    stops: stops.map(({ address, location, placeId }) => ({ address, location, placeId, contentId: placeId })) };
  const plan = await createWalkPlanner({ timeoutMs: 60000 })(input, { client: null });
  const document = planToWalkDocument(plan, { id: WALK_ID, title: TITLE, description: description(stops.length), mode: "open", minutes: 90, start: START });
  document.destination = FINISH;
  document.stops.forEach((stop, index) => {
    // The listener stands on the drawn line, at its point nearest to the object.
    const nearest = document.route.geometry.reduce((best, point) => distance(point, stop.place.location) < distance(best, stop.place.location) ? point : best);
    stop.triggerLocation = nearest;
    const next = stops[index + 1];
    stop.nextHint = next ? `Следующая остановка — ${next.name}. Следуйте по пешеходной линии на карте.` : "Дальше — метро «Лефортово», конец прогулки. Следуйте по пешеходной линии на карте.";
    assert.equal(stop.placeId, stops[index].placeId, "Планировщик изменил порядок остановок");
  });
  validateWalkDocument(document);
  writeFileSync(outPath, JSON.stringify(document, null, 2) + "\n");
  console.log(JSON.stringify({ distanceM: document.route.distanceM, walkingMinutes: document.route.walkingMinutes, stops: document.stops.length,
    triggers: document.stops.map((stop) => Math.round(distance(stop.triggerLocation, stop.place.location))) }));
} else if (mode === "create") {
  const [docPath] = paths;
  const { validateWalkDocument } = await load("walk-document.mjs");
  const { createAccountStore } = await load("account-store.mjs");
  const { PROMO_WALKS_USER_ID } = await load("promo-walks.mjs");
  const document = validateWalkDocument(JSON.parse(readFileSync(docPath, "utf8")));
  assert.equal(document.id, WALK_ID);
  const db = new DatabaseSync(process.env.AUTH_DATABASE_PATH ?? "/data/auth.sqlite", { timeout: 5000 });
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON");
    const accounts = createAccountStore(db);
    const walk = accounts.createWalk(PROMO_WALKS_USER_ID, { title: document.title, snapshot: document, idempotencyKey: IDEMPOTENCY_KEY }, { maxWalks: Infinity });
    // Link-only until the owner queues it for promo: no catalog listing yet.
    const shared = walk.visibility === "shared" ? walk : accounts.setWalkVisibility(PROMO_WALKS_USER_ID, walk.id, walk.revision, "shared");
    console.log(JSON.stringify({ id: shared.id, title: shared.title, revision: shared.revision, visibility: shared.visibility, shareToken: shared.shareToken }));
  } finally {
    db.close();
  }
} else if (mode === "update") {
  const [docPath, revision] = paths;
  const { validateWalkDocument } = await load("walk-document.mjs");
  const { createAccountStore } = await load("account-store.mjs");
  const { PROMO_WALKS_USER_ID } = await load("promo-walks.mjs");
  const document = validateWalkDocument(JSON.parse(readFileSync(docPath, "utf8")));
  assert.equal(document.id, WALK_ID);
  const db = new DatabaseSync(process.env.AUTH_DATABASE_PATH ?? "/data/auth.sqlite", { timeout: 5000 });
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON");
    const walk = createAccountStore(db).updateWalk(PROMO_WALKS_USER_ID, WALK_ID, { title: document.title, snapshot: document, revision: Number(revision) });
    assert.ok(walk, "Прогулка не найдена");
    console.log(JSON.stringify({ id: walk.id, title: walk.title, revision: walk.revision, visibility: walk.visibility, shareToken: walk.shareToken }));
  } finally {
    db.close();
  }
} else {
  throw new Error("Режим: plan, create или update");
}
