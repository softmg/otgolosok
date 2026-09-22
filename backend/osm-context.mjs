import discoveryCatalog from "./walk-discovery-catalog.mjs";

const text = value => typeof value === "string" ? value.trim() : "";
const unique = values => [...new Set(values.filter(Boolean))];
const memorialTypes = new Map([
  ["statue", "Памятник"], ["bust", "Бюст"], ["plaque", "Мемориальная доска"],
  ["stone", "Памятный камень"], ["stele", "Стела"], ["obelisk", "Обелиск"],
  ["cross", "Памятный крест"], ["war_memorial", "Военный мемориал"],
]);
const artworkTypes = new Map([
  ["sculpture", "Скульптура"], ["statue", "Статуя"], ["bust", "Бюст"],
  ["mural", "Мурал"], ["installation", "Инсталляция"], ["mosaic", "Мозаика"],
]);
const namedTypes = /^(?:памятник|бюст|мемориал(?:ьная доска|ьный объект)?|скульптура|статуя|стела|обелиск|памятный (?:камень|крест)|военный мемориал|арт-объект|мурал|инсталляция|мозаика|парк|сквер|сад|музей|галерея|смотровая площадка)(?=$|[\s«".,:—-])/iu;

function objectType(tags) {
  if (memorialTypes.has(tags.memorial)) return memorialTypes.get(tags.memorial);
  if (tags.historic === "monument") return "Памятник";
  if (tags.historic === "memorial") return "Мемориальный объект";
  if (artworkTypes.has(tags.artwork_type)) return artworkTypes.get(tags.artwork_type);
  if (tags.tourism === "artwork") return "Арт-объект";
  if (tags.tourism === "museum") return "Музей";
  if (tags.tourism === "gallery") return "Галерея";
  if (tags.tourism === "viewpoint") return "Смотровая площадка";
  if (tags.leisure === "park") return "Парк";
  if (tags.leisure === "garden") return "Сад";
  return null;
}

export function osmPostalAddress(tags = {}) {
  tags ??= {};
  if (text(tags["addr:full"])) return text(tags["addr:full"]);
  const street = text(tags["addr:street"]) || text(tags["addr:place"]);
  const number = text(tags["addr:housenumber"]);
  return street && number ? `${text(tags["addr:city"]) || "Москва"}, ${street}, ${number}` : null;
}

function nearbyLandmarks(place, elements) {
  const validPoint = point => Number.isFinite(point?.lat) && Number.isFinite(point?.lon)
    && Math.abs(point.lat) <= 90 && Math.abs(point.lon) <= 180;
  if (!validPoint(place.location)) return [];
  const radians = Math.PI / 180;
  const candidates = [];
  for (const element of elements) {
    const point = element.center;
    const id = `osm:${element.type}:${element.id}`;
    if (!validPoint(point) || id === (place.id ?? place.placeId)) continue;
    const dy = (point.lat - place.location.lat) * radians;
    const dx = (point.lon - place.location.lon) * radians;
    const a = Math.sin(dy / 2) ** 2 + Math.cos(place.location.lat * radians) * Math.cos(point.lat * radians) * Math.sin(dx / 2) ** 2;
    const distance = 6371000 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
    if (distance > 300) continue;
    const address = osmPostalAddress(element.tags);
    if (address) candidates.push({ osmId: id, name: text(element.tags?.name) || null, address,
      distanceMeters: Math.round(distance), location: point });
  }
  candidates.sort((a, b) => a.distanceMeters - b.distanceMeters || a.osmId.localeCompare(b.osmId));
  const seen = new Set();
  return candidates.filter(item => {
    if (seen.has(item.address)) return false;
    seen.add(item.address);
    return true;
  }).slice(0, 2);
}

// OSM labels are search hints; the source pages must still establish identity.
export function enrichOsmContext(place, { nearbyElements = discoveryCatalog.elements } = {}) {
  const tags = place.tags ?? {};
  const names = unique([place.name, tags["name:ru"], tags.name,
    ...[tags.official_name, tags.alt_name, tags.old_name].flatMap(value => text(value).split(";"))]
    .map(text)).slice(0, 8);
  const type = objectType(tags);
  const qualify = (name, prefix = type) => prefix && !namedTypes.test(name) ? `${prefix} ${name}` : name;
  const postalAddress = text(place.postalAddress) || text(place.address) || osmPostalAddress(tags);
  const geocoded = place.locationContext?.status === "matched" ? place.locationContext : null;
  const locationHint = postalAddress || unique([
    text(tags["addr:city"]) || "Москва", text(tags["addr:suburb"]) || text(geocoded?.district?.name),
    text(tags["addr:street"]) || text(tags["addr:place"]) || (text(geocoded?.street?.name) ? `около ${geocoded.street.name}` : ""),
  ]).join(", ");
  const searchName = qualify(names[0] || "");
  const searchNames = names.map(name => qualify(name));
  if (type === "Мемориальный объект" && names[0] && !namedTypes.test(names[0])) {
    searchNames.push(...["Памятник", "Мемориальная доска", "Бюст", "Памятный камень"]
      .map(prefix => qualify(names[0], prefix)));
  }
  const identifiers = prefix => Object.fromEntries(["wikidata", "wikipedia"]
    .filter(key => text(tags[`${prefix}${key}`])).map(key => [key, text(tags[`${prefix}${key}`])]));
  const geocodedLandmarks = geocoded ? [geocoded.containingBuilding, ...(geocoded.nearbyAddresses ?? [])].filter(Boolean) : [];
  const landmarks = geocodedLandmarks.length ? geocodedLandmarks : nearbyLandmarks(place, nearbyElements);
  const searchQueries = searchNames.map(name => `${name} ${locationHint}`);
  if (!postalAddress && (geocodedLandmarks.length || (!text(tags["addr:street"]) && !text(tags["addr:place"])))) {
    for (const landmark of landmarks) {
      for (const name of searchNames) searchQueries.push(`${name} ${locationHint}, рядом с ${landmark.address}`);
      if (landmark.name) searchQueries.push(`${searchName} ${locationHint} ${landmark.name}`);
    }
  }
  return {
    ...place, postalAddress, objectType: type, searchName, locationHint,
    alternateNames: names.slice(1),
    searchQueries: unique(searchQueries), nearbyLandmarks: landmarks,
    nearbyLandmarksSource: geocodedLandmarks.length ? geocoded.source : { source: discoveryCatalog.source, sourceSha256: discoveryCatalog.sourceSha256,
      attribution: discoveryCatalog.attribution },
    objectIdentifiers: identifiers(""), subjectIdentifiers: identifiers("subject:"),
  };
}
