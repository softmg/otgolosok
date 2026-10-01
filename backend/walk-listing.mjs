import { createHash } from "node:crypto";

export const LISTING_STATUSES = ["pending", "approved", "hidden"];

const text = value => typeof value === "string" ? value.normalize("NFC") : null;

/**
 * Digest of the texts an editor approves before a public walk enters the top.
 * Geometry, coordinates and story references are excluded, so rebuilding the
 * route without touching these texts keeps an approval.
 * @param {string} title account record title
 * @param {{title: string, description: string, start: {address: string} | null, destination?: {address: string} | null,
 *   stops: Array<{place: {address: string}, transition: string, nextHint: string}>}} document
 */
export function moderatedTextHash(title, document) {
  const texts = [text(title), text(document.title), text(document.description), text(document.start?.address), text(document.destination?.address),
    ...document.stops.map(stop => [text(stop.place.address), text(stop.transition), text(stop.nextHint)])];
  return createHash("sha256").update(JSON.stringify(texts)).digest("hex");
}
