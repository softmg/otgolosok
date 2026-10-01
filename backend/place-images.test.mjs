import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore } from "./store.mjs";
import { attributionFrom, createPlaceImageService, createWikimediaClient, fullWidthsFor, placeImageIdentifiers, placeImageInputHash,
  rejectReason, resolvePlaceImages, selectP18, startPlaceImageWorker } from "./place-images.mjs";

const UA = "Otgolosok/1.0 (+https://example.test; place photo sync)";
const instant = async () => {};
// Distinct URLs give distinct bytes, so a preview and a full copy never share a content-addressed name.
const jpeg = (size, label = "") => { const bytes = Buffer.alloc(size, 7);bytes.write(label.slice(0, Math.max(0, size - 3)), 3);bytes[0] = 0xff;bytes[1] = 0xd8;bytes[2] = 0xff;return bytes; };
const license = { LicenseShortName: { value: "CC BY-SA 4.0" }, LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0" },
  Artist: { value: "<a href=\"//commons.wikimedia.org/wiki/User:NVO\">NVO</a>" }, AttributionRequired: { value: "true" } };
const fileInfo = (overrides = {}) => ({ width: 4000, height: 3000, mime: "image/jpeg", sha1: "a".repeat(40), extmetadata: license, ...overrides });
const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

/**
 * A fake Wikimedia: Wikidata items, Wikipedia articles, Commons files and the media hosts, all in memory.
 * `mediaSize(url)` is the size of a downloaded thumbnail; `hook(url)` may return a response to override any call.
 * @param {any} [options]
 */
function fakeWikimedia({ entities = {}, articles = {}, files = {}, mediaSize = () => 10_000, hook = () => null } = {}) {
  const calls = [];
  const thumb = (title, width) => `https://thumb.wikimedia.org/wikipedia/commons/thumb/${encodeURIComponent(title)}/${width}px.jpg`;
  const fetch = async (url, init) => {
    calls.push({ url, userAgent: init?.headers?.["User-Agent"] });
    const overridden = await hook(url, calls.length, init);
    if (overridden) return overridden;
    const parsed = new URL(url), params = parsed.searchParams;
    if (parsed.hostname === "www.wikidata.org") {
      const ids = params.get("ids").split("|"), unknown = ids.find(id => !(id in entities));
      if (unknown) return json({ error: { code: "no-such-entity", id: unknown } });
      return json({ entities: Object.fromEntries(ids.map(id => [id, entities[id]])), success: 1 });
    }
    if (parsed.hostname.endsWith(".wikipedia.org")) {
      const titles = params.get("titles").split("|");
      return json({ query: { normalized: titles.filter(title => title.includes("_")).map(title => ({ from: title, to: title.replace(/_/g, " ") })),
        pages: titles.map(title => title.replace(/_/g, " ")).map(title => articles[title] ? { title, pageprops: { wikibase_item: articles[title] } } : { title, missing: true }) } });
    }
    if (parsed.hostname === "commons.wikimedia.org") {
      const width = Number(params.get("iiurlwidth"));
      return json({ query: { pages: params.get("titles").split("|").map(title => {
        const info = files[title];
        if (!info) return { title, missing: true };
        const thumbwidth = Math.min(width, info.width);
        return { title, imageinfo: [{ ...info, thumburl: thumb(title, thumbwidth), thumbmime: info.thumbmime ?? info.mime, thumbwidth,
          thumbheight: Math.round(thumbwidth * info.height / info.width), descriptionurl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(title)}` }] };
      }) } });
    }
    if (parsed.hostname === "thumb.wikimedia.org") return new Response(jpeg(mediaSize(url), url), { headers: { "content-type": "image/jpeg" } });
    return new Response("not found", { status: 404 });
  };
  return { fetch, calls };
}

const item = (id, file, rank = "normal") => ({ id, claims: file ? { P18: [{ rank, mainsnak: { datavalue: { value: file } } }] } : {} });
const client = (fake, options = {}) => createWikimediaClient({ fetch: fake.fetch, userAgent: UA, sleep: instant, apiIntervalMs: 0, mediaIntervalMs: 0, ...options });

test("place identifiers come from wikidata or wikipedia only", () => {
  for (const [tags, expected] of [
    [{ wikidata: "Q42" }, { wikidata: "Q42" }],
    [{ wikidata: " Q42 " }, { wikidata: "Q42" }],
    [{ wikidata: "Q0" }, {}],
    [{ wikidata: "q42" }, {}],
    [{ wikidata: "Q1;Q2", wikipedia: "ru:Дом Пашкова" }, { wikipedia: { lang: "ru", title: "Дом Пашкова" } }],
    [{ wikipedia: "ru:Дом_Пашкова" }, { wikipedia: { lang: "ru", title: "Дом Пашкова" } }],
    [{ wikipedia: "https://ru.wikipedia.org/wiki/%D0%93%D0%A3%D0%9C" }, { wikipedia: { lang: "ru", title: "ГУМ" } }],
    [{ wikipedia: "https://en.m.wikipedia.org/wiki/Red_Square#History" }, { wikipedia: { lang: "en", title: "Red Square" } }],
    [{ wikipedia: "RU:Title" }, {}],
    [{ wikipedia: "r:Title" }, {}],
    [{ wikipedia: `ru:${"а".repeat(256)}` }, {}],
    [{ wikipedia: "ru:A|B" }, {}],
    [{ wikipedia: "https://example.org/wiki/Title" }, {}],
    [{ "subject:wikidata": "Q7200" }, {}],
    [null, {}],
  ]) assert.deepEqual(placeImageIdentifiers(tags), expected, JSON.stringify(tags));
});

test("the input hash changes only with the identifiers", () => {
  const base = placeImageInputHash({ wikidata: "Q1", name: "A" });
  assert.equal(placeImageInputHash({ wikidata: "Q1", name: "B", "subject:wikidata": "Q5" }), base);
  assert.notEqual(placeImageInputHash({ wikidata: "Q2" }), base);
  assert.notEqual(placeImageInputHash({ wikidata: "Q1", wikipedia: "ru:A" }), base);
});

test("P18 prefers the preferred rank and ignores deprecated or non-string claims", () => {
  const claim = (rank, value) => ({ rank, mainsnak: { datavalue: { value } } });
  for (const [claims, expected] of [
    [[claim("normal", "a.jpg"), claim("preferred", "b.jpg")], "b.jpg"],
    [[claim("normal", "a.jpg"), claim("normal", "c.jpg")], "a.jpg"],
    [[claim("deprecated", "a.jpg")], null],
    [[claim("preferred", { id: 1 }), claim("normal", "c.jpg")], "c.jpg"],
    [[], null],
  ]) assert.equal(selectP18({ claims: { P18: claims } }), expected);
  assert.equal(selectP18({}), null);
});

test("full widths stay within the long-side limit and the original width", () => {
  for (const [width, height, expected] of [
    [4000, 3000, [960, 500, 330]],
    [3000, 3000, [960, 500, 330]],
    [3000, 4000, [500, 330]],
    [1000, 3000, []],
    [700, 500, [500, 330]],
    [400, 300, [330]],
  ]) assert.deepEqual(fullWidthsFor(width, height), expected, `${width}×${height}`);
});

test("attribution is plain text with an author fallback and a length cap", () => {
  assert.deepEqual(attributionFrom(license), { author: "NVO", license: "CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0", attributionRequired: true });
  assert.equal(attributionFrom({ Artist: { value: "A &amp; B &lt;C&gt; &quot;D&quot; &#39;E&#39; &#1046; &#x416;&nbsp;F" } }).author, "A & B <C> \"D\" 'E' Ж Ж F");
  assert.equal(attributionFrom({ Credit: { value: "<span>Own work</span>" } }).author, "Own work");
  assert.equal(attributionFrom({ AttributionRequired: { value: "false" } }).attributionRequired, false);
  assert.equal(attributionFrom({ LicenseUrl: { value: "//creativecommons.org/publicdomain/zero/1.0/" } }).licenseUrl, "https://creativecommons.org/publicdomain/zero/1.0/");
  const long = attributionFrom({ Artist: { value: `${"слово ".repeat(60)}` } }).author;
  assert.ok(long.length <= 200 && long.endsWith("…") && !long.includes("  "));
});

test("files are rejected for license, format and size reasons", () => {
  for (const [overrides, expected] of [
    [{}, null],
    [{ extmetadata: { ...license, NonFree: { value: "true" } } }, "non_free"],
    [{ extmetadata: { ...license, LicenseShortName: { value: " " } } }, "no_license"],
    [{ extmetadata: { LicenseShortName: { value: "CC BY 4.0" } } }, "no_attribution"],
    [{ extmetadata: { LicenseShortName: { value: "Public domain" }, AttributionRequired: { value: "false" } } }, null],
    [{ mime: "image/png", thumbmime: "image/png" }, "unsupported_format"],
    [{ mime: "image/tiff", thumbmime: "image/jpeg" }, null],
    [{ width: 499, height: 300 }, "too_small"],
    [{ width: 1000, height: 3100 }, "unsupported_ratio"],
  ]) assert.equal(rejectReason(fileInfo(overrides)), expected, JSON.stringify(overrides));
});

test("the client batches by 50, serializes API calls and identifies itself", async () => {
  const entities = Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`Q${index + 1}`, item(`Q${index + 1}`, "a.jpg")]));
  let active = 0, peak = 0;
  const fake = fakeWikimedia({ entities });
  const wrapped = { fetch: async (url, init) => { active++;peak = Math.max(peak, active);await new Promise(done => setTimeout(done, 2));try { return await fake.fetch(url, init); } finally { active--; } } };
  const wikimedia = client(wrapped);
  const ids = Object.keys(entities), [first, second] = await Promise.all([wikimedia.entities(ids.slice(0, 60)), wikimedia.entities(ids.slice(60))]);
  assert.equal(first.size + second.size, 120);
  assert.deepEqual(fake.calls.map(call => new URL(call.url).searchParams.get("ids").split("|").length).sort((a, b) => a - b), [10, 10, 50, 50]);
  assert.equal(peak, 1);
  assert.ok(fake.calls.every(call => call.userAgent === UA));
});

test("entities resolve redirects and drop deleted and never-existing ids", async () => {
  const fake = fakeWikimedia({ entities: { Q1: item("Q1", "a.jpg"), Q2: { id: "Q3", redirects: { from: "Q2", to: "Q3" }, claims: {} }, Q4: { id: "Q4", missing: "" } } });
  const result = await client(fake).entities(["Q1", "Q2", "Q4", "Q999"]);
  assert.deepEqual([...result.keys()].sort(), ["Q1", "Q2"]);
  assert.equal(result.get("Q2").id, "Q3");
  assert.equal(fake.calls.length, 2);
});

test("a server error is retried and then succeeds", async () => {
  const fake = fakeWikimedia({ entities: { Q1: item("Q1", "a.jpg") }, hook: (_, call) => call === 1 ? new Response("busy", { status: 503 }) : null });
  assert.equal((await client(fake).entities(["Q1"])).size, 1);
  assert.equal(fake.calls.length, 2);
});

test("a long Retry-After pauses every call and fails fast", async () => {
  let time = 1_000_000;
  const fake = fakeWikimedia({ hook: () => new Response("slow down", { status: 429, headers: { "retry-after": "120" } }) });
  const wikimedia = client(fake, { now: () => time });
  await assert.rejects(wikimedia.entities(["Q1"]), { code: "WIKIMEDIA_BUSY" });
  await assert.rejects(wikimedia.fileInfo(["File:a.jpg"], 250), { code: "WIKIMEDIA_BUSY" });
  assert.equal(fake.calls.length, 1);
  assert.equal(wikimedia.pausedUntil(), 1_000_000 + 120_000);
  time += 121_000;
  assert.equal(wikimedia.pausedUntil(), 0);
});

test("downloads accept only JPEGs from the Wikimedia media hosts within the byte cap", async () => {
  const redirected = Object.defineProperty(new Response(jpeg(10), { headers: { "content-type": "image/jpeg" } }), "url", { value: "https://evil.example/a.jpg" });
  /** @type {Array<[string, any, string]>} */
  const cases = [
    ["https://example.org/a.jpg", null, "FOREIGN_HOST"],
    ["http://upload.wikimedia.org/a.jpg", null, "FOREIGN_HOST"],
    ["https://upload.wikimedia.org/a.jpg", () => redirected, "FOREIGN_HOST"],
    ["https://upload.wikimedia.org/a.jpg", () => new Response(jpeg(10), { headers: { "content-type": "image/png" } }), "NOT_JPEG"],
    ["https://upload.wikimedia.org/a.jpg", () => new Response(Buffer.from("GIF89a"), { headers: { "content-type": "image/jpeg" } }), "NOT_JPEG"],
    ["https://upload.wikimedia.org/a.jpg", () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(jpeg(400)); } }), { headers: { "content-type": "image/jpeg" } }), "TOO_LARGE"],
  ];
  for (const [url, response, code] of cases) {
    const fake = fakeWikimedia({ hook: response ?? (() => null) });
    await assert.rejects(client(fake).download(url, 1000), { code }, `${url} → ${code}`);
    if (!response) assert.equal(fake.calls.length, 0);
  }
  const ok = await client(fakeWikimedia({ hook: () => new Response(jpeg(10), { headers: { "content-type": "image/jpeg" } }) })).download("https://upload.wikimedia.org/a.jpg", 1000);
  assert.equal(ok.bytes.length, 10);assert.match(ok.sha256, /^[a-f0-9]{64}$/);
});

test("resolution follows wikipedia to wikidata and reports every reason", async () => {
  const fake = fakeWikimedia({
    articles: { "Дом Пашкова": "Q10" },
    entities: { Q10: item("Q10", "Pashkov.jpg"), Q11: item("Q11", null), Q12: item("Q12", "Gone.jpg"), Q13: item("Q13", "Logo.png"), Q14: { id: "Q14", missing: "" } },
    files: { "File:Pashkov.jpg": fileInfo(), "File:Logo.png": fileInfo({ mime: "image/png" }) },
  });
  const result = await resolvePlaceImages([
    { id: "a", tags: { wikipedia: "ru:Дом_Пашкова" } },
    { id: "b", tags: { wikidata: "Q11" } },
    { id: "c", tags: { wikidata: "Q12" } },
    { id: "d", tags: { wikidata: "Q13" } },
    { id: "e", tags: { wikidata: "Q14" } },
    { id: "f", tags: { wikipedia: "ru:Нет такой статьи" } },
    { id: "g", tags: { "subject:wikidata": "Q10" } },
  ], { client: client(fake) });
  const candidate = /** @type {any} */ (result.get("a")).candidate;
  assert.equal(candidate.source, "wikipedia");assert.equal(candidate.entityId, "Q10");assert.equal(candidate.author, "NVO");
  assert.deepEqual(candidate.fullWidths, [960, 500, 330]);assert.deepEqual(candidate.fullSize, { width: 960, height: 720 });
  assert.match(candidate.previewUrl, /\/250px\.jpg$/);assert.match(candidate.fullUrl, /\/960px\.jpg$/);
  assert.deepEqual(Object.fromEntries([...result].map(([id, value]) => [id, /** @type {any} */ (value).reason]).filter(([, reason]) => reason)),
    { b: "no_p18", c: "file_missing", d: "unsupported_format", e: "no_entity", f: "no_entity", g: "no_identifier" });
});

const story = { title: "Дом Пашкова", paragraphs: [{ text: "Текст", factIds: ["f1"] }] };
/** A store with published places; tags per place id. */
function publishedStore(t, tagsById) {
  const store = createStore(":memory:", { maxActive: 100 });t.after(() => store.close());
  store.importPlaces({ source: "fixture", sourceSha256: "a".repeat(64), places: Object.entries(tagsById).map(([placeId, tags], index) => ({
    placeId, osmType: "node", osmId: Number(placeId.split(":").pop()), name: `Место ${index}`, location: { lat: 55.75 + index / 1000, lon: 37.61 }, tags })) });
  store.createBatch({ requestKey: "request-0001", name: "Pilot", placeIds: Object.keys(tagsById), limit: 50 });
  for (let job = store.claimContentJob(); job; job = store.claimContentJob()) { store.completeContentJob(job.id, { story, evidence: { facts: [] } });store.approvePlaceText(job.place.id); }
  return store;
}

/** @param {any} t @param {any} [options] */
function serviceFixture(t, { tags = { "osm:node:1": { wikidata: "Q1" } }, files = { "File:Pashkov.jpg": fileInfo() }, entities = { Q1: item("Q1", "Pashkov.jpg") }, ...options } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "place-images-"));t.after(() => rmSync(directory, { recursive: true, force: true }));
  let time = Date.parse("2026-10-01T00:00:00Z");
  const fake = fakeWikimedia({ entities, files, ...options });
  const store = publishedStore(t, tags), clock = { now: () => time, advance: ms => { time += ms; } };
  const service = createPlaceImageService({ store, client: client(fake, { now: clock.now }), directory, now: clock.now });
  const place = id => ({ id, tags: store.getPlace(id).tags });
  return { store, service, fake, directory, clock, place, files: () => readdirSync(directory).sort() };
}

test("ensure stores both files and a ready row, then makes no requests while fresh", async t => {
  const { store, service, fake, files, place } = serviceFixture(t);
  const row = await service.ensure(place("osm:node:1"));
  assert.equal(row.status, "ready");assert.equal(row.source, "wikidata");assert.equal(row.entityId, "Q1");assert.equal(row.width, 960);assert.equal(row.height, 720);
  assert.equal(files().length, 2);
  assert.match(row.thumbnailUrl, /^\/api\/place-images\/[a-f0-9]{64}\.jpg$/);
  const calls = fake.calls.length;
  await service.ensure(place("osm:node:1"));
  assert.equal(fake.calls.length, calls);
  assert.deepEqual(store.getPublishedPlace("osm:node:1").photo, { thumbnail: row.thumbnailUrl, src: row.srcUrl, width: 960, height: 720, alt: "Дом Пашкова",
    author: "NVO", sourceUrl: "https://commons.wikimedia.org/wiki/File%3APashkov.jpg", license: "CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0" });
});

test("concurrent ensure calls for one place share a single run", async t => {
  const { service, fake, place } = serviceFixture(t);
  const [first, second] = await Promise.all([service.ensure(place("osm:node:1")), service.ensure(place("osm:node:1"))]);
  assert.deepEqual(first, second);
  assert.equal(fake.calls.filter(call => call.url.includes("wikidata")).length, 1);
});

test("an oversized full image steps down to the next width; an oversized preview gives no photo", async t => {
  const big = serviceFixture(t, { mediaSize: url => url.includes("/960px") ? 300_000 : 20_000 });
  const row = await big.service.ensure(big.place("osm:node:1"));
  assert.equal(row.status, "ready");assert.equal(row.width, 500);assert.equal(row.height, 375);
  const preview = serviceFixture(t, { mediaSize: url => url.includes("/250px") ? 50_000 : 20_000 });
  const none = await preview.service.ensure(preview.place("osm:node:1"));
  assert.equal(none.status, "none");assert.equal(none.reason, "too_large");assert.equal(preview.files().length, 0);
  const nothing = serviceFixture(t, { mediaSize: url => url.includes("/250px") ? 20_000 : 300_000 });
  assert.equal((await nothing.service.ensure(nothing.place("osm:node:1"))).reason, "too_large");
});

test("rechecks reuse unchanged files, download a changed P18 and drop a deleted file", async t => {
  const entities = { Q1: item("Q1", "Pashkov.jpg") }, files = { "File:Pashkov.jpg": fileInfo(), "File:New.jpg": fileInfo({ sha1: "b".repeat(40) }) };
  const fixture = serviceFixture(t, { entities, files, mediaSize: url => url.includes("New.jpg") ? 12_000 : 10_000 });
  const first = await fixture.service.ensure(fixture.place("osm:node:1"));
  fixture.clock.advance(8 * 86_400_000);
  let downloads = fixture.fake.calls.filter(call => call.url.includes("thumb.wikimedia.org")).length;
  const same = (await fixture.service.syncDue()).ready;
  assert.equal(same, 1);
  assert.equal(fixture.fake.calls.filter(call => call.url.includes("thumb.wikimedia.org")).length, downloads);
  assert.equal(fixture.store.getPlaceImageRow("osm:node:1").srcUrl, first.srcUrl);

  entities.Q1 = item("Q1", "New.jpg");fixture.clock.advance(8 * 86_400_000);
  await fixture.service.syncDue();
  const changed = fixture.store.getPlaceImageRow("osm:node:1");
  assert.equal(changed.commonsTitle, "File:New.jpg");assert.notEqual(changed.srcUrl, first.srcUrl);
  downloads = fixture.fake.calls.filter(call => call.url.includes("thumb.wikimedia.org")).length;
  assert.equal(downloads, 4);

  delete files["File:New.jpg"];fixture.clock.advance(8 * 86_400_000);
  await fixture.service.syncDue();
  const gone = fixture.store.getPlaceImageRow("osm:node:1");
  assert.equal(gone.status, "none");assert.equal(gone.reason, "file_missing");
  assert.equal(fixture.store.getPublishedPlace("osm:node:1").photo, null);
});

test("transient failures keep a visible photo and back off; without a photo the row fails", async t => {
  let down = false;
  const fixture = serviceFixture(t, { tags: { "osm:node:1": { wikidata: "Q1" }, "osm:node:2": { wikidata: "Q1" } },
    hook: () => down ? new Response("down", { status: 503 }) : null });
  await fixture.service.ensure(fixture.place("osm:node:1"));
  down = true;fixture.clock.advance(8 * 86_400_000);
  const stats = await fixture.service.syncDue();
  assert.equal(stats.failed, 2);
  const kept = fixture.store.getPlaceImageRow("osm:node:1"), failed = fixture.store.getPlaceImageRow("osm:node:2");
  assert.equal(kept.status, "ready");assert.equal(kept.attempts, 1);assert.ok(fixture.store.getPublishedPlace("osm:node:1").photo);
  assert.equal(failed.status, "failed");assert.equal(failed.reason, "transient");
  const delay = row => Date.parse(row.nextCheckAt) - Date.parse(row.checkedAt);
  assert.equal(delay(failed), 5 * 60_000);
  fixture.clock.advance(5 * 60_000);
  await fixture.service.syncDue();
  assert.equal(delay(fixture.store.getPlaceImageRow("osm:node:2")), 10 * 60_000);
  assert.equal(fixture.store.getPlaceImageRow("osm:node:2").attempts, 2);
});

test("ensure gives up on its own timeout without throwing, but rethrows the caller's abort", async t => {
  // Like fetch, a hanging request ends when its signal aborts.
  const hang = (_, __, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  const fixture = serviceFixture(t, { hook: hang });
  const timedOut = await fixture.service.ensure(fixture.place("osm:node:1"), { timeoutMs: 20 });
  assert.equal(timedOut.status, "failed");
  const controller = new AbortController(), pending = fixture.service.ensure({ id: "osm:node:1", tags: { wikidata: "Q2" } }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending);
});

test("an editorial row is never touched by the sync", async t => {
  const fixture = serviceFixture(t);
  fixture.store.syncEditorialPlaceImages({ "osm:node:1": { thumbnail: "/images/places/node-1-aaaaaaaaaaaa.jpg", src: "/images/places/node-1-bbbbbbbbbbbb.jpg",
    width: 1280, height: 960, alt: "Редакционное фото", author: "Автор", sourceUrl: "https://commons.wikimedia.org/wiki/File:A.jpg", license: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0" } });
  const row = await fixture.service.ensure(fixture.place("osm:node:1"));
  assert.equal(row.source, "editorial");
  assert.equal((await fixture.service.syncDue()).processed, 0);
  assert.equal((await fixture.service.syncPlaces([fixture.place("osm:node:1")])).processed, 0);
  assert.equal(fixture.fake.calls.length, 0);
  assert.equal(fixture.store.savePlaceImage("osm:node:1", { status: "none", inputHash: "x", checkedAt: "2026-10-01T00:00:00.000Z", nextCheckAt: "2026-10-01T00:00:00.000Z" }), null);
});

test("the worker runs one sync at a time and stop aborts it", async () => {
  let runs = 0, active = 0, peak = 0, aborted = false;
  /** @type {(value?: unknown) => void} */
  let release = () => {};
  const service = /** @type {any} */ ({ syncDue: async ({ signal }) => {
    runs++;active++;peak = Math.max(peak, active);
    await new Promise(done => { release = done;signal.addEventListener("abort", () => { aborted = true;done(); }, { once: true }); });
    active--;return { processed: 0, failed: 0 };
  } });
  const worker = startPlaceImageWorker({ service, intervalMs: 60_000 });
  worker.wake();worker.wake();
  assert.equal(runs, 1);
  release();await new Promise(done => setTimeout(done, 0));
  worker.wake();assert.equal(runs, 2);
  await worker.stop();
  assert.equal(aborted, true);assert.equal(peak, 1);
  worker.wake();assert.equal(runs, 2);
});

test("a recheck downloads the photo again when its file is missing on disk", async t => {
  const fixture = serviceFixture(t);
  const first = await fixture.service.ensure(fixture.place("osm:node:1"));
  rmSync(join(fixture.directory, first.srcUrl.split("/").pop()));
  fixture.clock.advance(8 * 86_400_000);
  await fixture.service.syncDue();
  assert.ok(existsSync(join(fixture.directory, first.srcUrl.split("/").pop())));
});
