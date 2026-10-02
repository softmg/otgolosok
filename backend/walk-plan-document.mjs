import { validateWalkDocument } from "./walk-document.mjs";

// Server-side twin of draftToWalkDocument (src/features/walks/adapters.ts):
// the planner accepts 240-character addresses, a document stores at most 180.
const address = value => {
  const letters = Array.from(value);
  return letters.length > 180 ? `${letters.slice(0, 179).join("")}…` : value;
};
const place = value => ({ address: address(value.address), location: { lat: value.location.lat, lon: value.location.lon } });

/**
 * @param {{stops:Array<{address:string,location:{lat:number,lon:number},contentId?:string}>,geometry:Array<{lat:number,lon:number}>,distanceM:number,walkingMinutes:number,attribution:string,tunnels?:Array<[number,number]>}} plan
 * @param {{id:string,title:string,description:string,mode:"loop"|"open",minutes:number,start:{address:string,location:{lat:number,lon:number}}}} options
 */
export function planToWalkDocument(plan, { id, title, description, mode, minutes, start }) {
  const document = {
    version: 2, id, title, description, city: "Москва", mode, minutes,
    start: place(start),
    stops: plan.stops.map((stop, index) => ({
      id: `${id}-stop-${index}`.slice(0, 128),
      place: place(stop),
      storyRef: stop.contentId ? { kind: "osm", id: stop.contentId } : null,
      transition: "", nextHint: "",
    })),
    route: { geometry: plan.geometry.map(point => ({ lat: point.lat, lon: point.lon })), distanceM: plan.distanceM, walkingMinutes: plan.walkingMinutes, attribution: plan.attribution, ...(plan.tunnels ? { tunnels: plan.tunnels.map(([a, b]) => [a, b]) } : {}) },
    fieldChecked: false,
  };
  // Inputs are validated before planning, so a rejected document is a server
  // bug: it must surface as a logged 500, not as the caller's 400.
  try { return validateWalkDocument(document); }
  catch (error) { throw new Error("Planner result violates the walk document contract", { cause: error }); }
}
