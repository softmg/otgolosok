// Shared, dependency-free wire contract for walk documents and public views.
const invalid = () => Object.assign(new Error("Некорректные данные прогулки."), { code: "BAD_REQUEST" });
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const fields = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const string = (value, limit, empty = false) => typeof value === "string" && value.length <= limit && (empty || value.trim().length > 0) && !/[\p{Cc}\p{Cf}<>]/u.test(value);
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const point = value => fields(value, ["lat", "lon"]) && Number.isFinite(value.lat) && Number.isFinite(value.lon) && value.lat >= 55.48 && value.lat <= 55.98 && value.lon >= 37.30 && value.lon <= 37.95;
const place = value => fields(value, ["address", "location"]) && string(value.address, 180) && point(value.location);
const reference = value => value === null || (fields(value, ["kind", "id"]) && ((value.kind === "job" && uuid(value.id)) || (value.kind === "osm" && /^osm:(node|way|relation):\d+$/.test(value.id)) || (value.kind === "catalog" && /^[a-z0-9][a-z0-9-]{0,127}$/.test(value.id))));
const stop = value => fields(value, ["id", "place", "storyRef", "transition", "nextHint", "triggerLocation"]) && (uuid(value.id) || /^[a-z0-9][a-z0-9-]{0,127}$/.test(value.id)) && place(value.place) && reference(value.storyRef) && string(value.transition, 1200, true) && string(value.nextHint, 1200, true) && (value.triggerLocation === undefined || point(value.triggerLocation));
const geometry = value => Array.isArray(value) && value.length >= 2 && value.length <= 12000 && value.every(point);
const route = value => value === null || (fields(value, ["geometry", "distanceM", "walkingMinutes", "attribution"]) && geometry(value.geometry) && Number.isFinite(value.distanceM) && value.distanceM > 0 && value.distanceM <= 8100 && Number.isFinite(value.walkingMinutes) && value.walkingMinutes > 0 && value.walkingMinutes <= 90 && string(value.attribution, 2000));
const storyUrl = value => typeof value === "string" && value.length <= 2000 && /^https:\/\/[^\s<>]+$/i.test(value);
const story = value => value === null || (fields(value, ["title", "address", "paragraphs", "sources", "facts", "checkedAt"]) && string(value.title, 180) && string(value.address, 180) &&
  Array.isArray(value.paragraphs) && value.paragraphs.length > 0 && value.paragraphs.length <= 100 && value.paragraphs.every(item => fields(item, ["text", "factIds"]) && string(item.text, 6000) && Array.isArray(item.factIds) && item.factIds.length <= 100 && item.factIds.every(id => string(id, 128))) &&
  Array.isArray(value.sources) && value.sources.length <= 100 && value.sources.every(item => fields(item, ["id", "title", "url", "publisher"]) && string(item.id, 128) && string(item.title, 500) && storyUrl(item.url) && string(item.publisher, 500, true)) &&
  Array.isArray(value.facts) && value.facts.length <= 100 && value.facts.every(item => fields(item, ["id", "claim", "sourceIds"]) && string(item.id, 128) && string(item.claim, 2000) && Array.isArray(item.sourceIds) && item.sourceIds.length <= 100 && item.sourceIds.every(id => string(id, 128))) &&
  (value.checkedAt === undefined || (typeof value.checkedAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.checkedAt))));
const audio = value => value === null || (fields(value, ["url", "sha256", "durationSec"]) && typeof value.url === "string" && /^\/(?:audio\/walk\/[a-zA-Z0-9-]+\.mp3|api\/story-audio\/[a-f0-9]{64}\.mp3)$/.test(value.url) && typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256) && Number.isFinite(value.durationSec) && value.durationSec > 0 && value.durationSec <= 7200);

/** @typedef {{lat:number,lon:number}} Coordinates */
/** @typedef {{address:string,location:Coordinates}} WalkPlace */
/** @typedef {{version:2,id:string,title:string,description:string,city:string,mode:'open'|'loop',minutes:number,start:WalkPlace|null,stops:Array<{id:string,place:WalkPlace,storyRef:null|{kind:'job'|'osm'|'catalog',id:string},transition:string,nextHint:string,triggerLocation?:Coordinates}>,route:null|{geometry:Coordinates[],distanceM:number,walkingMinutes:number,attribution:string},fieldChecked:boolean}} WalkDocument */
/** @typedef {{document:WalkDocument,revision:number,contentVersion:string,chapters:Array<{id:string,status:string,story:object|null,audio:object|null}>}} WalkView */

export function validateWalkDocument(value) {
  if (!fields(value, ["version", "id", "title", "description", "city", "mode", "minutes", "start", "destination", "stops", "route", "fieldChecked"]) || value.version !== 2 || !(uuid(value.id) || /^[a-z0-9][a-z0-9-]{0,127}$/.test(value.id)) || !string(value.title, 120) || !string(value.description, 1000, true) || value.city !== "Москва" || !["open", "loop"].includes(value.mode) || ![15, 30, 60, 90].includes(value.minutes) || !(value.start === null || place(value.start)) || (value.destination != null && (value.mode !== "open" || !place(value.destination))) || !Array.isArray(value.stops) || value.stops.length > 10 || !value.stops.every(stop) || (value.start === null && value.stops.length !== 0) || new Set(value.stops.map(item => item.id)).size !== value.stops.length || !route(value.route) || (value.route !== null && (value.start === null || (value.stops.length === 0 && !value.destination))) || typeof value.fieldChecked !== "boolean" || JSON.stringify(value).length > 100000) throw invalid();
  return value;
}

// The stable UUID is assigned by the owner of the local/account record. Neither
// legacy job IDs nor the address label alone identify a route stop.
export function migrateLegacyDraft(value, walkId) {
  if (!object(value) || value.version !== 1 || !uuid(walkId) || !(value.start === null || place(value.start)) || !Array.isArray(value.stops) || value.stops.length > 10 || !value.stops.every(place) || (value.start === null && value.stops.length !== 0) || !["open", "loop"].includes(value.mode) || ![30, 60, 90].includes(value.minutes) || !Array.isArray(value.jobs) || value.jobs.length > 100) throw invalid();
  const hash = (index) => {
    // A UUIDv5-shaped deterministic ID; migration is stable across retries.
    // The input is already bounded by validateWalkDocument below.
    let seed = 2166136261;
    for (const letter of `${walkId}:${index}`) seed = Math.imul(seed ^ letter.charCodeAt(0), 16777619);
    const part = (seed >>> 0).toString(16).padStart(8, "0");
    return `${part}-${walkId.slice(9, 13)}-5${walkId.slice(15, 18)}-8${walkId.slice(20, 23)}-${walkId.slice(24)}`;
  };
  const link = selected => {
    const job = value.jobs.find(item => item?.place?.address === selected.address && item?.place?.location?.lat === selected.location.lat && item?.place?.location?.lon === selected.location.lon && uuid(item.id));
    return job ? { kind: "job", id: job.id } : null;
  };
  const locations = value.start ? [value.start, ...value.stops] : [];
  const includeStart = Boolean(value.start && link(value.start));
  const stops = (includeStart ? locations : value.stops).map((item, index) => ({ id: hash(index), place: item, storyRef: link(item), transition: "", nextHint: "" }));
  const savedRoute = value.route;
  const converted = { version: 2, id: walkId, title: value.title || "Моя прогулка", description: "", city: "Москва", mode: value.mode, minutes: value.minutes, start: value.start, ...(value.destination ? {destination:value.destination} : {}), stops,
    route: savedRoute ? { geometry: savedRoute.geometry, distanceM: savedRoute.distanceM, walkingMinutes: savedRoute.walkingMinutes, attribution: savedRoute.attribution } : null,
    fieldChecked: false };
  return validateWalkDocument(converted);
}

const statuses = new Set(["not_requested", "preparing", "text_ready", "ready", "failed", "review_required", "insufficient_evidence", "unavailable"]);
export function validateWalkView(value) {
  const document = validateWalkDocument(value?.document);
  if (!fields(value, ["document", "revision", "contentVersion", "chapters"]) || !Number.isSafeInteger(value.revision) || value.revision < 0 || !string(value.contentVersion, 120) || !Array.isArray(value.chapters) || value.chapters.length !== document.stops.length || value.chapters.some((item, index) => !fields(item, ["id", "status", "story", "audio"]) || item.id !== document.stops[index].id || !statuses.has(item.status) || !story(item.story) || !audio(item.audio) || (item.audio !== null && item.story === null)) || JSON.stringify(value).length > 200000) throw invalid();
  return value;
}
