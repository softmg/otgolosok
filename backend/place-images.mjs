import { createHash, randomBytes } from "node:crypto";
import { rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isTransientError, isTransientStatus, retryAfterMs, sleep, withRetry } from "./retry.mjs";

// Place photos: the main image (Wikidata P18) of the item an OSM place links to, copied from Wikimedia Commons
// thumbnails into DATA_DIR/place-images and served from our own origin. The editorial catalog always wins.

const DAY_MS = 86_400_000;
export const PLACE_IMAGE_LIMITS = Object.freeze({
  previewWidth: 250, previewMaxBytes: 40_000,
  fullMaxSide: 960, fullMaxBytes: 250_000,
  // Wikimedia standard thumbnail widths only: other widths are rounded up or rejected by the media servers.
  fullWidths: Object.freeze([960, 500, 330]),
  minOriginalWidth: 500,
  recheckMs: 7 * DAY_MS, retryBaseMs: 5 * 60_000, retryMaxMs: DAY_MS,
});
export const EDITORIAL_NEXT_CHECK = "9999-12-31T00:00:00.000Z";
export const PLACE_IMAGE_FILE = /^[a-f0-9]{64}\.jpg$/;
export const PLACE_IMAGE_URL_PREFIX = "/api/place-images/";

const QID = /^Q[1-9]\d{0,15}$/;
const WIKI_LANG = /^[a-z][a-z-]{1,11}$/;
// Characters MediaWiki forbids in titles; "|" would also break batched requests.
const BAD_TITLE = /[#<>[\]|{}\u0000-\u001f]/;
const MEDIA_HOSTS = new Set(["upload.wikimedia.org", "thumb.wikimedia.org"]);
const EDITORIAL_ID = /^osm:(?:node|way|relation):\d+$/;
const EDITORIAL_PATH = /^\/images\/places\/[a-z0-9-]+\.jpg$/;
const CHUNK = 50;

const chunks = (items, size = CHUNK) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
const fail = (code, message = code, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const isPositiveInt = value => Number.isSafeInteger(value) && value > 0;
const httpUrl = value => {
  if (typeof value !== "string") return null;
  try { const url = new URL(value.startsWith("//") ? `https:${value}` : value); return ["http:", "https:"].includes(url.protocol) ? url.href : null; }
  catch { return null; }
};

function wikipediaTitle(lang, title) {
  const clean = title.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  if (!WIKI_LANG.test(lang) || !clean || clean.length > 255 || BAD_TITLE.test(clean)) return null;
  return { lang, title: clean };
}

function parseWikipedia(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (/^https?:\/\//i.test(text)) {
    let url;
    try { url = new URL(text); } catch { return null; }
    const host = /^([a-z][a-z-]{1,11})\.(?:m\.)?wikipedia\.org$/.exec(url.hostname);
    if (!host || !url.pathname.startsWith("/wiki/")) return null;
    let title;
    try { title = decodeURIComponent(url.pathname.slice("/wiki/".length)); } catch { return null; }
    return wikipediaTitle(host[1], title);
  }
  const match = /^([a-z][a-z-]{1,11}):(.+)$/.exec(text);
  return match ? wikipediaTitle(match[1], match[2]) : null;
}

/**
 * The identifiers a photo is looked up by. `subject:wikidata` is never used: its P18 is a portrait of the person,
 * not the monument. A multi-valued `wikidata` (Q1;Q2) does not say which item is the place, so it is ignored.
 * @param {Record<string, unknown> | null | undefined} tags
 * @returns {{wikidata?: string, wikipedia?: {lang: string, title: string}}}
 */
export function placeImageIdentifiers(tags) {
  const result = {};
  const wikidata = typeof tags?.wikidata === "string" ? tags.wikidata.trim() : "";
  if (QID.test(wikidata)) result.wikidata = wikidata;
  const wikipedia = parseWikipedia(tags?.wikipedia);
  if (wikipedia) result.wikipedia = wikipedia;
  return result;
}

/** Changes exactly when the identifiers a photo is resolved from change. @param {Record<string, unknown> | null | undefined} tags */
export function placeImageInputHash(tags) {
  const { wikidata = null, wikipedia = null } = placeImageIdentifiers(tags);
  return createHash("sha256").update(JSON.stringify({ wikidata, wikipedia: wikipedia && [wikipedia.lang, wikipedia.title] })).digest("hex");
}

/** The Commons file name of an item's main image: the first preferred claim, else the first normal one. */
export function selectP18(entity) {
  const claims = Array.isArray(entity?.claims?.P18) ? entity.claims.P18 : [];
  const value = claim => claim?.mainsnak?.datavalue?.value;
  const usable = claims.filter(claim => typeof value(claim) === "string" && value(claim).trim());
  const chosen = usable.find(claim => claim.rank === "preferred") ?? usable.find(claim => claim.rank === "normal");
  return chosen ? value(chosen).trim() : null;
}

/** Standard widths for the full copy, largest first, whose height also stays within the long-side limit. */
export function fullWidthsFor(width, height, limits = PLACE_IMAGE_LIMITS) {
  if (!isPositiveInt(width) || !isPositiveInt(height)) return [];
  return limits.fullWidths.filter(w => w <= width && Math.round(w * height / width) <= limits.fullMaxSide);
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'", apos: "'", nbsp: " " };
function plainText(html, max = 200) {
  if (typeof html !== "string") return "";
  const text = html.replace(/<(?:br|\/p|\/div|\/li)\b[^>]*>/gi, " ").replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]+\d*|#39);/gi, (entity, name) => {
      const lower = name.toLowerCase();
      if (ENTITIES[lower] !== undefined) return ENTITIES[lower];
      const code = lower.startsWith("#x") ? parseInt(lower.slice(2), 16) : lower.startsWith("#") ? Number(lower.slice(1)) : NaN;
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    })
    .replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1), space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, "")}…`;
}

/** Author and license as plain text from Commons extmetadata (Artist and Credit are HTML). */
export function attributionFrom(extmetadata) {
  const value = key => extmetadata?.[key]?.value;
  const author = plainText(value("Artist")) || plainText(value("Credit")) || null;
  const required = String(value("AttributionRequired") ?? "true").trim().toLowerCase() !== "false";
  return { author, license: plainText(value("LicenseShortName"), 100), licenseUrl: httpUrl(value("LicenseUrl")), attributionRequired: required };
}

/** Why a Commons file cannot be shown, or null when it can. @param {any} info imageinfo with extmetadata */
export function rejectReason(info, limits = PLACE_IMAGE_LIMITS) {
  if (String(info?.extmetadata?.NonFree?.value ?? "").trim().toLowerCase() === "true") return "non_free";
  const attribution = attributionFrom(info?.extmetadata);
  if (!attribution.license) return "no_license";
  if (attribution.attributionRequired && !attribution.author) return "no_attribution";
  if ((info?.thumbmime ?? info?.mime) !== "image/jpeg") return "unsupported_format";
  if (!isPositiveInt(info?.width) || info.width < limits.minOriginalWidth) return "too_small";
  if (!fullWidthsFor(info.width, info.height, limits).length) return "unsupported_ratio";
  return null;
}

/**
 * Validates the editorial catalog (OSM place id → local copies in public/images/places) and returns its rows.
 * A malformed catalog throws: the backend must not start with a broken override list.
 */
export function editorialPlaceImages(catalog) {
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) throw fail("INVALID_EDITORIAL_CATALOG", "Editorial photo catalog must be an object");
  return Object.entries(catalog).map(([placeId, photo]) => {
    const bad = field => fail("INVALID_EDITORIAL_CATALOG", `Editorial photo ${placeId}: invalid ${field}`);
    if (!EDITORIAL_ID.test(placeId)) throw bad("place id");
    if (!EDITORIAL_PATH.test(photo?.thumbnail) || !EDITORIAL_PATH.test(photo?.src) || photo.thumbnail === photo.src) throw bad("file paths");
    if (!isPositiveInt(photo.width) || !isPositiveInt(photo.height)) throw bad("size");
    for (const field of ["alt", "author", "license"]) if (typeof photo[field] !== "string" || !photo[field].trim()) throw bad(field);
    const sourceUrl = httpUrl(photo.sourceUrl), licenseUrl = httpUrl(photo.licenseUrl);
    if (!sourceUrl || new URL(sourceUrl).hostname !== "commons.wikimedia.org") throw bad("sourceUrl");
    if (!licenseUrl) throw bad("licenseUrl");
    return { placeId, thumbnailUrl: photo.thumbnail, srcUrl: photo.src, width: photo.width, height: photo.height, alt: photo.alt.trim(),
      author: photo.author.trim(), license: photo.license.trim(), licenseUrl, sourceUrl };
  });
}

/** Serialized tasks with a minimum gap between starts (Wikimedia robot policy: concurrency 1, < 5 req/s). */
function serialQueue(intervalMs, now, wait) {
  let tail = Promise.resolve(), lastStart = -Infinity;
  return (task, signal) => {
    const run = tail.then(async () => {
      signal?.throwIfAborted();
      const delay = lastStart + intervalMs - now();
      if (delay > 0) await wait(delay, signal);
      lastStart = now();
      return task();
    });
    tail = run.catch(() => {});
    return run;
  };
}

/**
 * Wikimedia Action API and media client. API calls and downloads each go through their own serialized queue.
 * A 429 with a long or missing Retry-After pauses every call for at least a minute (WIKIMEDIA_BUSY).
 * @param {{fetch?: typeof fetch, userAgent: string, now?: () => number, sleep?: (ms: number, signal?: AbortSignal) => Promise<unknown>,
 *   apiIntervalMs?: number, mediaIntervalMs?: number, random?: () => number}} options
 */
export function createWikimediaClient({ fetch: fetchImpl = globalThis.fetch, userAgent, now = Date.now, sleep: wait = sleep, apiIntervalMs = 250, mediaIntervalMs = 100, random = Math.random }) {
  if (typeof userAgent !== "string" || !userAgent.trim()) throw new TypeError("userAgent is required");
  const apiQueue = serialQueue(apiIntervalMs, now, wait), mediaQueue = serialQueue(mediaIntervalMs, now, wait);
  let pausedUntil = 0;
  const busy = () => fail("WIKIMEDIA_BUSY", `Wikimedia asked to slow down until ${new Date(pausedUntil).toISOString()}`, { transient: true, retryAt: pausedUntil });

  /** One request with up to 3 attempts for network errors, 5xx and a short 429. Returns an ok response. */
  async function request(url, headers, signal) {
    const response = await withRetry(async attempt => {
      if (now() < pausedUntil) throw busy();
      const response = await fetchImpl(url, { headers: { "User-Agent": userAgent, ...headers }, signal });
      if (response.ok) return response;
      await response.body?.cancel().catch(() => {});
      const hinted = retryAfterMs(response.headers.get("retry-after"), now());
      if (response.status === 429 && (hinted === null || hinted > 8000)) {
        pausedUntil = now() + Math.max(hinted ?? 0, 60_000);
        throw busy();
      }
      throw fail("WIKIMEDIA_HTTP", `Wikimedia responded with HTTP ${response.status}`,
        { status: response.status, retryAfter: response.headers.get("retry-after"), transient: isTransientStatus(response.status), attempt });
    }, { attempts: 3, signal, wait, random, isTransient: (/** @type {any} */ error) => error?.code !== "WIKIMEDIA_BUSY" && isTransientError(error) });
    return response;
  }

  async function api(base, params, signal) {
    return apiQueue(async () => {
      const url = `${base}?${new URLSearchParams({ ...params, format: "json", formatversion: "2", maxlag: "5" })}`;
      const response = await request(url, { "Accept-Encoding": "gzip" }, signal);
      /** @type {any} */
      let body;
      try { body = await response.json(); }
      catch (error) { throw fail("WIKIMEDIA_BAD_RESPONSE", "Wikimedia returned malformed JSON", { transient: true, cause: error }); }
      if (body?.error) {
        const transient = ["maxlag", "ratelimited", "readonly", "internal_api_error_DBQueryError"].includes(body.error.code);
        throw fail(body.error.code === "no-such-entity" ? "NO_SUCH_ENTITY" : "WIKIMEDIA_API_ERROR", `Wikimedia API error ${body.error.code}`, { transient, apiCode: body.error.code, entityId: body.error.id });
      }
      return body;
    }, signal);
  }

  /** Map input title → final page title through `normalized` and `redirects`. */
  const finalTitle = (query, title) => {
    const step = (list, value) => (Array.isArray(list) ? list.find(item => item.from === value)?.to : undefined) ?? value;
    return step(query?.redirects, step(query?.normalized, title));
  };

  return {
    pausedUntil: () => pausedUntil > now() ? pausedUntil : 0,
    /** Items by requested id (a redirected id maps to its target entity); deleted and never-existing ids are absent. */
    async entities(ids, signal) {
      const result = new Map();
      for (const part of chunks([...new Set(ids)])) {
        let pending = part;
        while (pending.length) {
          let body;
          try { body = await api("https://www.wikidata.org/w/api.php", { action: "wbgetentities", ids: pending.join("|"), props: "claims" }, signal); }
          catch (error) {
            // An id that never existed fails the whole request instead of coming back as "missing".
            if (error.code === "NO_SUCH_ENTITY" && pending.includes(error.entityId)) { pending = pending.filter(id => id !== error.entityId); continue; }
            throw error;
          }
          for (const [key, entity] of Object.entries(body?.entities ?? {})) {
            if (!entity || Object.hasOwn(entity, "missing")) continue;
            result.set(entity.redirects?.from ?? key, entity);
          }
          pending = [];
        }
      }
      return result;
    },
    /** Wikidata item ids of Wikipedia articles, keyed by the input title. */
    async wikipediaItems(lang, titles, signal) {
      if (!WIKI_LANG.test(lang)) throw new TypeError("Invalid Wikipedia language");
      const result = new Map();
      for (const part of chunks([...new Set(titles)])) {
        const body = await api(`https://${lang}.wikipedia.org/w/api.php`, { action: "query", prop: "pageprops", ppprop: "wikibase_item", redirects: "1", titles: part.join("|") }, signal);
        const items = new Map((body?.query?.pages ?? []).filter(page => QID.test(page?.pageprops?.wikibase_item ?? "")).map(page => [page.title, page.pageprops.wikibase_item]));
        for (const title of part) { const item = items.get(finalTitle(body?.query, title)); if (item) result.set(title, item); }
      }
      return result;
    },
    /** Commons imageinfo (with a thumbnail of `width`) keyed by the input "File:…" title; missing files are absent. */
    async fileInfo(titles, width, signal) {
      const result = new Map();
      for (const part of chunks([...new Set(titles)])) {
        const body = await api("https://commons.wikimedia.org/w/api.php", { action: "query", prop: "imageinfo",
          iiprop: "url|size|mime|thumbmime|sha1|extmetadata", iiextmetadatafilter: "Artist|Credit|LicenseShortName|LicenseUrl|AttributionRequired|NonFree",
          iiurlwidth: String(width), titles: part.join("|") }, signal);
        const pages = new Map((body?.query?.pages ?? []).filter(page => !page.missing && Array.isArray(page.imageinfo) && page.imageinfo[0]).map(page => [page.title, { ...page.imageinfo[0], title: page.title }]));
        for (const title of part) { const info = pages.get(finalTitle(body?.query, title)); if (info) result.set(title, info); }
      }
      return result;
    },
    /** A JPEG from the Wikimedia media hosts, streamed with a byte cap. */
    async download(url, maxBytes, signal) {
      const allowed = value => { try { const parsed = new URL(value); return parsed.protocol === "https:" && MEDIA_HOSTS.has(parsed.hostname); } catch { return false; } };
      if (!allowed(url)) throw fail("FOREIGN_HOST", "Refusing to download from a non-Wikimedia host");
      return mediaQueue(async () => {
        const response = await request(url, {}, signal);
        const cancel = () => response.body?.cancel().catch(() => {});
        if (response.url && !allowed(response.url)) { await cancel(); throw fail("FOREIGN_HOST", "Download redirected to a non-Wikimedia host"); }
        if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "image/jpeg") { await cancel(); throw fail("NOT_JPEG", "Downloaded file is not a JPEG"); }
        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > maxBytes) { await cancel(); throw fail("TOO_LARGE", "Downloaded file is too large"); }
        if (!response.body) throw fail("NOT_JPEG", "Downloaded file is empty");
        const parts = [];let size = 0;
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) { await reader.cancel().catch(() => {}); throw fail("TOO_LARGE", "Downloaded file is too large"); }
          parts.push(value);
        }
        const bytes = Buffer.concat(parts);
        if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw fail("NOT_JPEG", "Downloaded file is not a JPEG");
        return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
      }, signal);
    },
  };
}

/**
 * Resolves the photo candidate of every place in a few batched API calls.
 * @param {{id: string, tags: Record<string, unknown>}[]} places
 * @param {{client: ReturnType<typeof createWikimediaClient>, signal?: AbortSignal, limits?: typeof PLACE_IMAGE_LIMITS}} options
 * @returns {Promise<Map<string, {candidate: any} | {reason: string}>>}
 */
export async function resolvePlaceImages(places, { client, signal, limits = PLACE_IMAGE_LIMITS }) {
  const result = new Map(), lookups = new Map();
  for (const place of places) {
    const ids = placeImageIdentifiers(place.tags);
    if (ids.wikidata) lookups.set(place.id, { source: "wikidata", entityId: ids.wikidata });
    else if (ids.wikipedia) lookups.set(place.id, { source: "wikipedia", wikipedia: ids.wikipedia });
    else result.set(place.id, { reason: "no_identifier" });
  }
  const byLang = new Map();
  for (const lookup of lookups.values()) if (lookup.wikipedia) byLang.set(lookup.wikipedia.lang, [...byLang.get(lookup.wikipedia.lang) ?? [], lookup.wikipedia.title]);
  for (const [lang, titles] of byLang) {
    const items = await client.wikipediaItems(lang, titles, signal);
    for (const lookup of lookups.values()) if (lookup.wikipedia?.lang === lang) lookup.entityId = items.get(lookup.wikipedia.title);
  }
  for (const [id, lookup] of lookups) if (!lookup.entityId) { result.set(id, { reason: "no_entity" }); lookups.delete(id); }

  const entities = await client.entities([...lookups.values()].map(lookup => lookup.entityId), signal);
  for (const [id, lookup] of lookups) {
    const entity = entities.get(lookup.entityId);
    const file = entity ? selectP18(entity) : null;
    if (!entity || !file) { result.set(id, { reason: entity ? "no_p18" : "no_entity" }); lookups.delete(id); continue; }
    lookup.entityId = entity.id ?? lookup.entityId;
    lookup.commonsTitle = `File:${file}`;
  }

  const previews = await client.fileInfo([...lookups.values()].map(lookup => lookup.commonsTitle), limits.previewWidth, signal);
  const byWidth = new Map();
  for (const [id, lookup] of lookups) {
    const info = previews.get(lookup.commonsTitle);
    const reason = info ? rejectReason(info, limits) : "file_missing";
    if (reason || !httpUrl(info.thumburl) || !httpUrl(info.descriptionurl)) { result.set(id, { reason: reason ?? "file_missing" }); lookups.delete(id); continue; }
    const attribution = attributionFrom(info.extmetadata), fullWidths = fullWidthsFor(info.width, info.height, limits);
    lookup.candidate = { source: lookup.source, entityId: lookup.entityId, commonsTitle: lookup.commonsTitle, commonsSha1: typeof info.sha1 === "string" ? info.sha1 : null,
      previewUrl: info.thumburl, fullWidths, fullUrl: null, fullSize: null, author: attribution.author, license: attribution.license,
      licenseUrl: attribution.licenseUrl ?? info.descriptionurl, sourceUrl: info.descriptionurl };
    byWidth.set(fullWidths[0], [...byWidth.get(fullWidths[0]) ?? [], lookup.commonsTitle]);
  }
  const fulls = new Map();
  for (const [width, titles] of byWidth) for (const [title, info] of await client.fileInfo(titles, width, signal)) fulls.set(`${width}:${title}`, info);
  for (const [id, lookup] of lookups) {
    const { candidate } = lookup, info = fulls.get(`${candidate.fullWidths[0]}:${candidate.commonsTitle}`);
    if (!info?.thumburl || !isPositiveInt(info.thumbwidth) || !isPositiveInt(info.thumbheight)) { result.set(id, { reason: "file_missing" }); continue; }
    result.set(id, { candidate: { ...candidate, fullUrl: info.thumburl, fullSize: { width: info.thumbwidth, height: info.thumbheight } } });
  }
  return result;
}

const rejected = reason => fail("PLACE_IMAGE_REJECTED", reason, { reason });

async function writeOnce(directory, name, bytes) {
  const path = join(directory, name);
  if (await stat(path).then(info => info.isFile(), () => false)) return;
  const temporary = join(directory, `.tmp-${randomBytes(8).toString("hex")}`);
  try { await writeFile(temporary, bytes, { flag: "wx" }); await rename(temporary, path); }
  catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
}

/**
 * Downloads the preview and the largest full copy within the byte cap and stores both under content-addressed names.
 * @returns {Promise<{thumbnailUrl: string, srcUrl: string, width: number, height: number, bytes: number}>}
 */
export async function storePlaceImage(candidate, { client, directory, signal, limits = PLACE_IMAGE_LIMITS }) {
  const tooLarge = error => { if (error?.code === "TOO_LARGE") throw rejected("too_large"); throw error; };
  const preview = await client.download(candidate.previewUrl, limits.previewMaxBytes, signal).catch(tooLarge);
  let url = candidate.fullUrl, size = candidate.fullSize, full;
  for (let index = 0; !full; index++) {
    try { full = await client.download(url, limits.fullMaxBytes, signal); }
    catch (error) {
      const next = candidate.fullWidths[index + 1];
      if (error?.code !== "TOO_LARGE") throw error;
      if (!next) throw rejected("too_large");
      const info = (await client.fileInfo([candidate.commonsTitle], next, signal)).get(candidate.commonsTitle);
      if (!info?.thumburl || !isPositiveInt(info.thumbwidth) || !isPositiveInt(info.thumbheight)) throw rejected("file_missing");
      url = info.thumburl;size = { width: info.thumbwidth, height: info.thumbheight };
    }
  }
  await writeOnce(directory, `${preview.sha256}.jpg`, preview.bytes);
  await writeOnce(directory, `${full.sha256}.jpg`, full.bytes);
  return { thumbnailUrl: `${PLACE_IMAGE_URL_PREFIX}${preview.sha256}.jpg`, srcUrl: `${PLACE_IMAGE_URL_PREFIX}${full.sha256}.jpg`, width: size.width, height: size.height,
    bytes: preview.bytes.length + full.bytes.length };
}

// Download failures that will not change by retrying soon: the next weekly recheck tries again.
const DOWNLOAD_REASONS = { FOREIGN_HOST: "invalid_download", NOT_JPEG: "invalid_download" };
const isTransientFailure = error => error?.transient === true || ["TimeoutError", "AbortError"].includes(error?.name) || isTransientError(error);
const fileOf = url => typeof url === "string" && url.startsWith(PLACE_IMAGE_URL_PREFIX) ? url.slice(PLACE_IMAGE_URL_PREFIX.length) : null;

/**
 * @param {{store: any, client: ReturnType<typeof createWikimediaClient>, directory: string, now?: () => number, logs?: any, limits?: typeof PLACE_IMAGE_LIMITS}} options
 */
export function createPlaceImageService({ store, client, directory, now = Date.now, logs = null, limits = PLACE_IMAGE_LIMITS }) {
  const inFlight = new Map();
  const iso = time => new Date(time).toISOString();
  const filesExist = row => Promise.all([row.thumbnailUrl, row.srcUrl].map(url => {
    const name = fileOf(url);
    return name ? stat(join(directory, name)).then(info => info.isFile(), () => false) : false;
  })).then(results => results.every(Boolean));

  /** Saves the outcome for one place; returns the stored row and its counter key. */
  async function settle(place, previous, outcome, { signal, own }, stats) {
    const time = now(), inputHash = placeImageInputHash(place.tags), base = { inputHash, checkedAt: iso(time), alt: null };
    const none = (reason, source = null) => ({ ...base, status: "none", source, reason, attempts: 0, nextCheckAt: iso(time + limits.recheckMs),
      entityId: null, commonsTitle: null, commonsSha1: null, thumbnailUrl: null, srcUrl: null, width: null, height: null, author: null, license: null, licenseUrl: null, sourceUrl: null });
    const transient = () => {
      const attempts = (previous?.attempts ?? 0) + 1, nextCheckAt = iso(time + Math.min(limits.retryMaxMs, limits.retryBaseMs * 2 ** (attempts - 1)));
      // A transient failure never removes a visible photo; it keeps its old identifiers so the recheck happens.
      if (previous?.status === "ready") return { ...previous, attempts, reason: "transient", checkedAt: iso(time), nextCheckAt };
      return { ...none("transient"), status: "failed", attempts, nextCheckAt };
    };
    let fields;
    if (outcome.error) fields = transient();
    else if (outcome.reason) fields = none(outcome.reason);
    else {
      const { candidate } = outcome;
      const meta = { ...base, status: "ready", source: candidate.source, reason: null, attempts: 0, nextCheckAt: iso(time + limits.recheckMs),
        entityId: candidate.entityId, commonsTitle: candidate.commonsTitle, commonsSha1: candidate.commonsSha1,
        author: candidate.author, license: candidate.license, licenseUrl: candidate.licenseUrl, sourceUrl: candidate.sourceUrl };
      const reusable = previous?.status === "ready" && candidate.commonsSha1 && previous.commonsSha1 === candidate.commonsSha1
        && candidate.fullWidths.includes(previous.width) && await filesExist(previous);
      if (reusable) fields = { ...meta, thumbnailUrl: previous.thumbnailUrl, srcUrl: previous.srcUrl, width: previous.width, height: previous.height };
      else {
        try {
          const stored = await storePlaceImage(candidate, { client, directory, signal: own, limits });
          stats.downloadedBytes += stored.bytes;
          fields = { ...meta, thumbnailUrl: stored.thumbnailUrl, srcUrl: stored.srcUrl, width: stored.width, height: stored.height };
        } catch (error) {
          if (signal?.aborted) throw error;
          if (error?.code === "PLACE_IMAGE_REJECTED") fields = none(error.reason, candidate.source);
          else if (DOWNLOAD_REASONS[error?.code]) fields = none(DOWNLOAD_REASONS[error.code], candidate.source);
          else if (error?.code === "WIKIMEDIA_HTTP" && !error.transient) fields = none("download_failed", candidate.source);
          else if (isTransientFailure(error)) fields = transient();
          else { logs?.captureException(error, { operation: "placeImages", context: { placeId: place.id } }); fields = transient(); }
        }
      }
    }
    return store.savePlaceImage(place.id, fields);
  }

  /**
   * Resolves and stores photos for `entries`; `signal` is the caller's, `own` adds this run's timeout.
   * @param {{place: {id: string, tags: any}, row: any}[]} entries
   */
  async function processEntries(entries, { signal, own = signal }) {
    const stats = { processed: 0, ready: 0, none: {}, failed: 0, downloadedBytes: 0 }, rows = new Map();
    if (!entries.length) return { stats, rows };
    let resolved = null, batchError = null;
    try { resolved = await resolvePlaceImages(entries.map(entry => entry.place), { client, signal: own, limits }); }
    catch (error) {
      if (signal?.aborted) throw error;
      if (!isTransientFailure(error)) logs?.captureException(error, { operation: "placeImages", context: { places: entries.length } });
      batchError = error;
    }
    for (const { place, row } of entries) {
      const outcome = batchError ? { error: batchError } : resolved.get(place.id) ?? { reason: "no_identifier" };
      const saved = await settle(place, row, outcome, { signal, own }, stats);
      if (!saved) continue;
      rows.set(place.id, saved);stats.processed++;
      if (saved.status === "ready" && !saved.reason) stats.ready++;
      else if (saved.status === "none") stats.none[saved.reason] = (stats.none[saved.reason] ?? 0) + 1;
      else stats.failed++;
    }
    return { stats, rows };
  }

  return {
    /**
     * Makes sure one place has a current photo row before it is published. Never throws for Wikimedia or file errors;
     * only the caller's own abort propagates.
     * @param {{id: string, tags: any}} place @param {{signal?: AbortSignal, timeoutMs?: number}} [options]
     */
    async ensure(place, { signal, timeoutMs } = {}) {
      const row = store.getPlaceImageRow(place.id);
      if (row?.source === "editorial") return row;
      if (row && row.inputHash === placeImageInputHash(place.tags) && row.nextCheckAt > iso(now())) return row;
      if (!inFlight.has(place.id)) {
        const own = AbortSignal.any([...(signal ? [signal] : []), ...(timeoutMs ? [AbortSignal.timeout(timeoutMs)] : [])]);
        const task = processEntries([{ place, row }], { signal, own }).then(result => result.rows.get(place.id) ?? store.getPlaceImageRow(place.id))
          .finally(() => inFlight.delete(place.id));
        inFlight.set(place.id, task);
      }
      try { return await inFlight.get(place.id); }
      catch (error) {
        if (signal?.aborted) throw error;
        // Another caller's abort ended the shared run; this caller still gets whatever is stored.
        return store.getPlaceImageRow(place.id);
      }
    },
    /**
     * One batch of due places. Skipped entirely while Wikimedia asked to slow down.
     * @param {{limit?: number, signal?: AbortSignal}} [options]
     */
    async syncDue({ limit = 50, signal } = {}) {
      const pausedUntil = client.pausedUntil();
      if (pausedUntil) return { processed: 0, ready: 0, none: {}, failed: 0, downloadedBytes: 0, pausedUntil: iso(pausedUntil) };
      const { stats } = await processEntries(store.listDuePlaceImages({ limit, now: iso(now()) }), { signal });
      const paused = client.pausedUntil();
      return paused ? { ...stats, pausedUntil: iso(paused) } : stats;
    },
    /**
     * Rechecks the given places now, fresh or not (editorial rows are skipped).
     * @param {{id: string, tags: any}[]} places @param {{signal?: AbortSignal}} [options]
     */
    async syncPlaces(places, { signal } = {}) {
      const entries = places.map(place => ({ place, row: store.getPlaceImageRow(place.id) })).filter(entry => entry.row?.source !== "editorial");
      const { stats } = await processEntries(entries, { signal });
      return stats;
    },
  };
}

/**
 * Background sync: one `syncDue` run at a time, repeated while places are due; the timer only wakes it.
 * @param {{service: ReturnType<typeof createPlaceImageService>, intervalMs?: number, logs?: any}} options
 */
export function startPlaceImageWorker({ service, intervalMs = 60_000, logs = null }) {
  const controller = new AbortController();let running = null, stopped = false;
  const run = async () => {
    try {
      for (;;) {
        const result = await service.syncDue({ signal: controller.signal });
        // Transient failures back off per place; the next tick continues with the rest.
        if (!result.processed || result.failed || result.pausedUntil || controller.signal.aborted) break;
      }
    } catch (error) {
      if (!controller.signal.aborted) logs?.captureException(error, { operation: "placeImageWorker" });
    } finally { running = null; }
  };
  const wake = () => { if (!stopped && !running) running = run(); return running; };
  const timer = setInterval(wake, intervalMs);timer.unref?.();
  wake();
  return { wake, stop: async () => { stopped = true;clearInterval(timer);controller.abort();await running; } };
}

/** The bot User-Agent the Wikimedia robot policy asks for: our name and a contact URL. @param {string} origin */
export const placeImageUserAgent = origin => `Otgolosok/1.0 (+${origin}; place photo sync)`;
