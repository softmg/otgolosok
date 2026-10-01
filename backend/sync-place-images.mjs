#!/usr/bin/env node
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createStore } from "./store.mjs";
import { createPlaceImageService, createWikimediaClient, PLACE_IMAGE_FILE, placeImageUserAgent, resolvePlaceImages } from "./place-images.mjs";

// Lives in backend/ so the generator image ships it: docker exec <backend> node sync-place-images.mjs …
// Works on DATA_DIR/jobs.sqlite and DATA_DIR/place-images regardless of PLACE_IMAGE_SYNC (the server's own switch).
const usage = "Usage: node backend/sync-place-images.mjs [--dry-run] [--limit N] [--place <placeId>]... [--recheck-all] [--prune]";
const argv = process.argv.slice(2), places = [];let limit = Infinity, dryRun = false, recheckAll = false, prune = false;
for (let index = 0; index < argv.length; index++) {
  const flag = argv[index];
  if (flag === "--dry-run") dryRun = true;
  else if (flag === "--recheck-all") recheckAll = true;
  else if (flag === "--prune") prune = true;
  else if (flag === "--limit" && /^[1-9]\d{0,5}$/.test(argv[index + 1] ?? "")) limit = Number(argv[++index]);
  else if (flag === "--place" && /^osm:(?:node|way|relation):\d+$/.test(argv[index + 1] ?? "")) places.push(argv[++index]);
  else { console.error(usage); process.exit(1); }
}
if (prune && (dryRun || recheckAll || places.length) || (recheckAll && places.length)) { console.error(usage); process.exit(1); }

const directory = resolve(process.env.DATA_DIR ?? "backend/data"), imageDirectory = join(directory, "place-images");
const store = createStore(join(directory, "jobs.sqlite"));
const DAY_MS = 86_400_000;

async function pruneFiles() {
  const referenced = store.listReferencedPlaceImageFiles(), now = Date.now();let removed = 0, temporaries = 0;
  for (const name of await readdir(imageDirectory).catch(() => [])) {
    const path = join(imageDirectory, name), temporary = name.startsWith(".tmp-");
    if (!temporary && (!PLACE_IMAGE_FILE.test(name) || referenced.has(name))) continue;
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || info.mtimeMs >= now - (temporary ? DAY_MS : 7 * DAY_MS)) continue;
    await rm(path, { force: true });
    if (temporary) temporaries++;else removed++;
  }
  return { referenced: referenced.size, removed, temporaries };
}

/** The published places named by --place; an unknown or unpublished id is an operator error. */
function selectedPlaces() {
  return places.map(id => {
    const place = store.getPublishedPlace(id);
    if (!place) { console.error(`${id} is not a published place`); process.exit(1); }
    return { id: place.id, name: place.name, tags: place.tags };
  });
}

const add = (total, part) => {
  for (const key of ["processed", "ready", "failed", "downloadedBytes"]) total[key] += part[key];
  for (const [reason, count] of Object.entries(part.none)) total.none[reason] = (total.none[reason] ?? 0) + count;
  if (part.pausedUntil) total.pausedUntil = part.pausedUntil;
  return total;
};

let exitCode = 0;
try {
  if (prune) console.log(JSON.stringify(await pruneFiles(), null, 2));
  else {
    if (!process.env.APP_ORIGIN) throw new Error("APP_ORIGIN is required: Wikimedia asks bots to identify themselves with a contact URL");
    const client = createWikimediaClient({ userAgent: placeImageUserAgent(process.env.APP_ORIGIN) });
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    if (dryRun) {
      // Resolution only: no downloads and no writes. A far-future "now" lists every published place for --recheck-all.
      const targets = places.length ? selectedPlaces()
        : store.listDuePlaceImages({ limit: Number.isFinite(limit) ? limit : 100000, now: recheckAll ? "9999-12-31T00:00:00.000Z" : new Date().toISOString() }).map(entry => entry.place);
      const resolved = await resolvePlaceImages(targets, { client, signal: controller.signal });
      const summary = { places: targets.length, ready: 0, none: {} };
      for (const outcome of resolved.values()) if ("candidate" in outcome) summary.ready++;else summary.none[outcome.reason] = (summary.none[outcome.reason] ?? 0) + 1;
      console.log(JSON.stringify(summary, null, 2));
    } else {
      const service = createPlaceImageService({ store, client, directory: imageDirectory });
      await mkdir(imageDirectory, { recursive: true });
      const total = { processed: 0, ready: 0, none: {}, failed: 0, downloadedBytes: 0 };
      if (places.length) add(total, await service.syncPlaces(selectedPlaces(), { signal: controller.signal }));
      else {
        if (recheckAll) store.markPlaceImagesDue({ placeIds: null });
        while (total.processed < limit) {
          const part = await service.syncDue({ limit: Math.min(50, limit - total.processed), signal: controller.signal });
          add(total, part);
          // A batch that failed as a whole means Wikimedia is unreachable: stop instead of marking the whole backlog failed.
          if (!part.processed || part.pausedUntil || part.failed === part.processed) break;
        }
      }
      console.log(JSON.stringify(total, null, 2));
      if (total.pausedUntil) { console.error(`Wikimedia asked to slow down; run again after ${total.pausedUntil}`); exitCode = 1; }
    }
  }
} catch (error) {
  console.error(error?.code === "WIKIMEDIA_BUSY" ? `Wikimedia asked to slow down; run again after ${new Date(error.retryAt).toISOString()}` : error);
  exitCode = 1;
} finally {
  store.close();
}
process.exit(exitCode);
