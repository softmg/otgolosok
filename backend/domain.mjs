import { createHash } from "node:crypto";

export const PIPELINE_VERSION = "place-history-v6";
export const EDITORIAL_EVIDENCE_VERSION = 2;
export const TERMINAL = new Set(["ready", "failed", "insufficient_evidence", "review_required"]);
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export function failure(code, message = code) { return Object.assign(new Error(message), { code }); }

export function normalizeAddress(value) {
  if (typeof value !== "string") throw failure("INVALID_ADDRESS");
  const address = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (address.length < 6 || address.length > 180 || !/\d/.test(address) ||
      !/^[\p{L}\p{N}\s.,/()№–—-]+$/u.test(address) || /^[-\d.,\s]+$/.test(address)) throw failure("INVALID_ADDRESS");
  return /москва/iu.test(address) ? address : `Москва, ${address}`;
}

export function addressKey(address) {
  return sha256(`${PIPELINE_VERSION}|ru|${address.toLocaleLowerCase("ru").replace(/ё/g, "е")
    .replace(/[.,]/g, " ").replace(/\s+/g, " ").trim()}`);
}

export function parseModelJson(text) {
  if (typeof text !== "string" || text.length > 65000) throw failure("INVALID_MODEL_OUTPUT");
  const match = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (match?.[1] ?? text).trim();
  try {
    const value = JSON.parse(candidate);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw failure("INVALID_MODEL_OUTPUT"); }
}

function decodeEntities(text) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", laquo: "«", raquo: "»", hellip: "…" };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, name) => {
    if (!name.startsWith("#")) return named[name.toLowerCase()] ?? all;
    const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
  });
}

export function pageText(html) {
  const clean = html.replace(/<(script|style|noscript|svg|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  const main = /<(?:article|main)\b[^>]*>([\s\S]*?)<\/(?:article|main)\s*>/i.exec(clean)?.[1];
  return decodeEntities(main ?? clean).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 22000);
}

export function comparable(text) {
  // Stress marks (Собо́р, Михаи́ла) are common in Wikipedia and models drop or move them when quoting.
  return text.normalize("NFKC").replace(/[\u0300\u0301]/g, "").toLocaleLowerCase("ru").replace(/ё/g, "е")
    .replace(/[«»“”„]/g, '"').replace(/[–—]/g, "-").replace(/\u00ad/g, "").replace(/\s+/g, " ").trim();
}

// A house number or building part: shown to listeners as an address, so it needs a confirmed kind=address fact.
const POSTAL_LOCATION = /(?:^|[\s,])(?:д\.|дом[аеу]?|вл\.?|владение|стр\.|строение|корп\.|корпус|к\.?|с\.?)\s*\d|,\s*\d+[а-яё]?(?:\/\d+)?\s*(?:$|,|\s)/iu;
const shortText = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max;

/** Quotes must exist in the fetched page, not merely in a search snippet. */
/**
 * identityMode "address": the requested address is the identity (user-entered address), so it must be confirmed.
 * identityMode "place": an OSM place is identified by name, type and location; a postal address is optional.
 * Address facts are kept only when the model confirmed the object's own address; otherwise an identity fact
 * about the object is required instead.
 */
export function validateFacts(result, sources, { requireEditorialScope = false, identityMode = "address" } = {}) {
  if (!["address", "place"].includes(identityMode)) throw new TypeError(`Unknown identityMode: ${identityMode}`);
  if (identityMode === "place" && !requireEditorialScope) throw new TypeError("identityMode place needs classified facts (requireEditorialScope)");
  if (identityMode === "address" && result.addressConfirmed !== true) throw failure("ADDRESS_UNCLEAR");
  if (identityMode === "place" && result.identityConfirmed !== true) throw failure("PLACE_UNCLEAR");
  const addressAllowed = identityMode === "address" || result.addressConfirmed === true;
  if (!shortText(result.placeName, 160) || !shortText(result.resolvedAddress, 200) || !Array.isArray(result.facts)) throw failure("INVALID_MODEL_OUTPUT");
  const seen = new Set(),seenClaims=new Set();let nextId=1;
  const facts = result.facts.slice(0, 8).flatMap((fact) => {
    const id = `f${nextId}`;
    if (!fact || seen.has(fact.id) || !shortText(fact.claim, 600) || !Array.isArray(fact.evidence)) return [];
    // Legacy editorial checkpoints remain editable. New research must classify
    // every fact; excluded or unlocated material cannot fill the five-fact quota.
    const scoped = requireEditorialScope || ["topic", "scope", "location", "distanceMeters"].some(key => Object.hasOwn(fact, key));
    if (scoped && (!["architecture", "place_history"].includes(fact.topic) ||
        !["building", "site", "nearby"].includes(fact.scope) || !shortText(fact.location, 240) ||
        (fact.scope === "nearby" && (!Number.isFinite(fact.distanceMeters) || fact.distanceMeters <= 0 || fact.distanceMeters > 300)))) return [];
    if (requireEditorialScope && (!["identity", "address", "content"].includes(fact.kind) ||
        !["object", "site_context", "nearby"].includes(fact.subjectRelation) ||
        (fact.kind === "content" && !shortText(fact.contentReason, 300)) ||
        (fact.kind === "address" && fact.subjectRelation !== "object"))) return [];
    if (!addressAllowed && fact.kind === "address") return [];
    const claimKey=comparable(fact.claim);
    if(requireEditorialScope&&seenClaims.has(claimKey))return [];
    const evidence = fact.evidence.slice(0, 3).filter((proof) => {
      const source = sources.find((item) => item.id === proof?.sourceId);
      return source && shortText(proof.quote, 500) && proof.quote.trim().length >= 18 &&
        comparable(source.text).includes(comparable(proof.quote));
    });
    if (!evidence.length) return [];
    seen.add(fact.id ?? id);if(requireEditorialScope)seenClaims.add(claimKey);nextId++;
    return [{ id, claim: fact.claim, interesting: fact.interesting === true,
      ...(scoped ? {topic:fact.topic,scope:fact.scope,location:fact.location.trim(),distanceMeters:fact.scope === "nearby" ? fact.distanceMeters : null} : {}),
      ...(requireEditorialScope ? {kind:fact.kind,subjectRelation:fact.subjectRelation,
        ...(fact.kind === "content" ? {contentReason:fact.contentReason.trim()} : {})} : {}),
      evidence: evidence.map(({sourceId, quote}) => ({sourceId, quote})) }];
  });
  const used = new Set(facts.flatMap((fact) => fact.evidence.map((proof) => proof.sourceId)));
  // Without a confirmed own address, only an identity fact about the object itself anchors the story to this place.
  if (!addressAllowed && !facts.some(fact => fact.kind === "identity" && fact.subjectRelation === "object")) {
    // The model named the object, but its quote did not survive the exact-excerpt check: an editor can verify it by hand.
    const offered = Array.isArray(result.facts) && result.facts.some(fact => fact?.kind === "identity" && fact?.subjectRelation === "object");
    throw failure(offered ? "IDENTITY_QUOTE_INVALID" : "PLACE_UNCLEAR");
  }
  if (!facts.length || (requireEditorialScope && !facts.some(fact=>fact.kind === "content"))) throw failure("INSUFFICIENT_EVIDENCE");
  return { ...(requireEditorialScope?{version:EDITORIAL_EVIDENCE_VERSION}:result.version===undefined?{}:{version:result.version}),
    identityNote:shortText(result.identityNote,1000)?result.identityNote.trim():undefined,
    ...(identityMode === "place" ? { addressConfirmed: addressAllowed } : {}),
    placeName: result.placeName.trim(), resolvedAddress: addressAllowed || !POSTAL_LOCATION.test(result.resolvedAddress) ? result.resolvedAddress.trim() : result.placeName.trim(), facts,
    sources: sources.filter((source) => used.has(source.id)) };
}

export function validateDraft(draft, evidence) {
  if (!shortText(draft.title, 140) || !Array.isArray(draft.paragraphs) || draft.paragraphs.length < 2 || draft.paragraphs.length > 6) throw failure("INVALID_DRAFT");
  const factIds = new Set(evidence.facts.map((fact) => fact.id));
  const used = new Set();
  const paragraphs = draft.paragraphs.map((paragraph) => {
    if (!shortText(paragraph?.text, 2000) || !Array.isArray(paragraph.factIds) || !paragraph.factIds.length ||
        !paragraph.factIds.every((id) => factIds.has(id))) throw failure("INVALID_DRAFT");
    paragraph.factIds.forEach((id) => used.add(id));
    return { text: paragraph.text.trim(), factIds: [...new Set(paragraph.factIds)] };
  });
  const script = paragraphs.map((paragraph) => paragraph.text).join("\n\n");
  const wordCount = script.split(/\s+/).length;
  if (wordCount < 100 || wordCount > 250 || used.size < 1) throw failure("INVALID_DRAFT", `Expected 100-250 words and supported facts; got ${wordCount} words and ${used.size} facts.`);
  return { title: draft.title.trim(), address: evidence.resolvedAddress, paragraphs, wordCount,
    verification: "automatic", sources: evidence.sources.map(({ id, url, title, publisher }) => ({id, url, title, publisher})),
    facts: evidence.facts.filter((fact) => used.has(fact.id)).map((fact) => ({id: fact.id, claim: fact.claim, sourceIds: fact.evidence.map((proof) => proof.sourceId)})) };
}

export function publicJob(job) {
  return { id: job.id, address: job.address, stage: job.stage, revision: job.revision,
    createdAt: job.createdAt, updatedAt: job.updatedAt,
    story: job.data.story ?? null, audio: job.data.audio ?? job.data.revoice?.previousAudio ?? null,
    elapsedSec: TERMINAL.has(job.stage) && job.data.elapsedSec !== undefined ? job.data.elapsedSec : Math.round((Date.now() - Date.parse(job.createdAt)) / 1000),
    error: job.error, canRetry: job.stage === "failed" && job.attempts < 3 };
}
