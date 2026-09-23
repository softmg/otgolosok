import { comparable, failure } from "./domain.mjs";
import { assessPlaceEligibility } from "./place-eligibility.mjs";

// Triage of places that fail the regular filter with weak_identity. It never makes a
// place eligible: it only ranks candidates for a bounded pilot and explains the ranking.
export const IDENTITY_RULES_VERSION = "identity-triage-v1";
export const IDENTITY_TIERS = ["auto", "enrich", "manual"];
export const AUTO_SCORE = 70;

const text = value => typeof value === "string" ? value.trim() : "";
const initials = /^[А-ЯЁA-Z](?:\.\s*[А-ЯЁA-Z])?\.?(?:\s+[А-ЯЁа-яё-]+)?$/u;
const typedName = /^(?:памятник|бюст|мемориал\S*|скульптура|статуя|стела|обелиск|памятн\S+ (?:камень|крест|знак)|парк|сквер|сад|музей\S*|дом-музей|галерея|смотровая площадка|усадьба|городская усадьба|кладбище|церковь|храм|часовня|собор|монастырь|роща|выставочный зал|театр|грот|беседка|ротонда|фонтан|ворота|башня|палаты)(?=$|[\s«"'.,:—-])/iu;
const toponym = /(?:^|\s)(?:улица|переулок|площадь|проезд|набережная|бульвар|шоссе|проспект|тупик|аллея)(?=$|\s)/iu;
const stopWords = new Set(["и", "в", "на", "у", "по", "для", "имени", "им", "им.", "the", "of"]);

export function identityNameKey(name) {
  return comparable(text(name)).replace(/["'`]/g, "").replace(/\s+/g, " ");
}

export function identityCategory(tags = {}) {
  if (tags.tourism) return `tourism:${tags.tourism}`;
  if (tags.historic) return `historic:${tags.historic}`;
  if (tags.leisure) return `leisure:${tags.leisure}`;
  return tags.heritage ? "heritage" : "other";
}

/** Keeps only what the editor and the tiering need; the full context is recomputed by the pipeline. */
export function summarizeLocation(context) {
  if (!context || context.status !== "matched") return { status: context?.status ?? "unavailable" };
  const building = context.containingBuilding?.address ? {
    address: context.containingBuilding.address, relation: context.containingBuilding.relation,
  } : null;
  const nearest = context.nearbyAddresses?.find(item => item?.address) ?? null;
  return {
    status: "matched", building,
    nearestAddress: nearest ? { address: nearest.address, distanceMeters: nearest.distanceMeters } : null,
    street: context.street?.name ? { name: context.street.name, distanceMeters: context.street.distanceMeters } : null,
    district: context.district?.name ?? null,
  };
}

/**
 * Score and tier of one weak_identity place. `nameCount` is how many active catalog places
 * share the normalized name; namesakes cannot be told apart without an external identifier.
 */
export function assessIdentityCandidate(place, { locationContext = null, nameCount = 1 } = {}) {
  const tags = place?.tags ?? {}, name = text(place?.name), eligibility = assessPlaceEligibility(place);
  if (eligibility.eligible || !eligibility.reasons.includes("weak_identity") || eligibility.reasons.includes("missing_coordinates")) return null;
  const location = summarizeLocation(locationContext), signals = [], reasons = [];
  let score = 0;
  const signal = (code, points) => { signals.push(code); score += points; };
  const words = name.split(/\s+/u).filter(word => /[\p{L}\d]/u.test(word));
  const typed = typedName.test(name);

  if (name.length >= 4 && !initials.test(name)) signal("informative_name", 15); else reasons.push("uninformative_name");
  if (eligibility.signals.includes("specific_type")) signal("specific_type", 10); else reasons.push("missing_specific_type");
  if (typed) signal("typed_name", 10);
  if (words.length >= 2 && name.length >= 12) signal("distinctive_name", 10); else reasons.push("short_name");
  if (nameCount <= 1) signal("unique_name", 15); else { reasons.push("duplicate_name"); score -= 20; }
  if (!typed && toponym.test(name)) reasons.push("toponym_name");

  // For a park or a manor the stored coordinate is only a representative point; a building around it says
  // nothing about the whole object, so building anchors count for point objects only.
  const area = Boolean(place?.geometry && place.geometry.type !== "Point");
  if (!area && location.building?.relation === "point_in_building") signal("inside_address_building", 25);
  else if (!area && location.building) signal("on_address_building_edge", 20);
  else if (!area && location.nearestAddress && location.nearestAddress.distanceMeters <= 50) signal("nearby_address_50m", 10);
  else reasons.push("no_address_anchor");
  if (location.status !== "matched") reasons.push("no_location_context");
  if (location.street && location.street.distanceMeters <= 100) signal("street_100m", 5);
  if (location.district) signal("district", 5);
  if (area) signal("area_geometry", 10);
  if ((text(tags["name:ru"]) && tags["name:ru"] !== tags.name) || tags.official_name || tags.old_name || tags.alt_name || tags.heritage || tags.architect) signal("extra_tags", 5);
  score = Math.max(0, Math.min(100, score));

  const anchoredToBuilding = signals.includes("inside_address_building") || signals.includes("on_address_building_edge");
  const anchored = anchoredToBuilding || (signals.includes("area_geometry") && typed && signals.includes("district"));
  const blocked = reasons.includes("missing_specific_type") || reasons.includes("toponym_name")
    || (reasons.includes("short_name") && reasons.includes("duplicate_name"))
    // "И. В. Мичурину" on an addressed building can be looked up by address; without it, only by hand.
    || (reasons.includes("uninformative_name") && !anchoredToBuilding);
  const tier = blocked ? "manual"
    : score >= AUTO_SCORE && anchored && signals.includes("unique_name") && signals.includes("distinctive_name") && signals.includes("informative_name")
      ? "auto" : "enrich";
  return { tier, score, reasons, signals, category: identityCategory(tags), location };
}

function nameVariants(place) {
  const tags = place?.tags ?? {};
  const values = [place?.name, tags.name, tags["name:ru"], ...[tags.official_name, tags.alt_name, tags.old_name]
    .flatMap(value => text(value).split(";"))];
  return [...new Set(values.map(text).filter(value => value.length >= 4))];
}

const tokens = value => identityNameKey(value).split(/[\s,.:;!?()«»—–-]+/u).filter(token => token.length >= 3 && !stopWords.has(token));
// A stem tolerates Russian case endings: "сквере Бунина" names "Сквер Бунина".
const stem = token => token.slice(0, Math.max(4, token.length - 2));

/**
 * A name variant is found in a quote when every proper-name token is there and at least
 * 60 % of all significant tokens are. Capitalised words after the first carry the identity.
 */
export function quoteNamesPlace(quote, place) {
  const quoteTokens = tokens(quote);
  const present = token => quoteTokens.some(candidate => candidate.startsWith(stem(token)));
  return nameVariants(place).some(variant => {
    const all = tokens(variant);
    if (!all.length) return false;
    const proper = variant.split(/\s+/u).slice(1).filter(word => /^[«"]?[А-ЯЁA-Z]/u.test(word)).flatMap(tokens);
    const required = proper.length ? proper : all.length <= 2 ? all : [];
    return required.every(present) && all.filter(present).length / all.length >= 0.6;
  });
}

/**
 * Evidence for a weak_identity job: only facts about the object itself, and at least one
 * identity fact whose quote names the object as OSM does. Otherwise an editor decides.
 */
export function restrictWeakIdentityEvidence(evidence, place) {
  const facts = evidence.facts.filter(fact => fact.subjectRelation === "object");
  const named = facts.some(fact => fact.kind === "identity" && fact.evidence.some(proof => quoteNamesPlace(proof.quote, place)));
  if (!named) throw failure("IDENTITY_UNCONFIRMED");
  if (!facts.some(fact => fact.kind === "content")) throw failure("INSUFFICIENT_EVIDENCE");
  const used = new Set(facts.flatMap(fact => fact.evidence.map(proof => proof.sourceId)));
  return { ...evidence, identityPolicy: "weak_identity", facts, sources: evidence.sources.filter(source => used.has(source.id)) };
}

/**
 * Assesses a whole catalog snapshot: `places` are active places with `contentHash`; name frequency is
 * counted over all of them, including eligible ones. `resolveLocation` is the offline OSM address index.
 */
export function buildIdentityCandidates(places, { resolveLocation = null } = {}) {
  const counts = new Map();
  for (const place of places) { const key = identityNameKey(place.name); counts.set(key, (counts.get(key) ?? 0) + 1); }
  const candidates = [];
  for (const place of places) {
    const eligibility = assessPlaceEligibility(place);
    if (eligibility.eligible || !eligibility.reasons.includes("weak_identity") || eligibility.reasons.includes("missing_coordinates")) continue;
    const locationContext = resolveLocation ? resolveLocation({ id: place.id, location: place.location }) : null;
    const result = assessIdentityCandidate(place, { locationContext, nameCount: counts.get(identityNameKey(place.name)) });
    candidates.push({ placeId: place.id, contentHash: place.contentHash, ...result });
  }
  return candidates;
}
