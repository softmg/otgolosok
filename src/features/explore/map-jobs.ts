import type { Coordinates } from "../tour/types";
import type { GenerationJob } from "../generator/types";

const KEY = "otgolosok:map-jobs";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export type MapJob = { id: string; address: string; location: Coordinates };
/** Центр Москвы (Кремль): сюда возвращаем карту, если пользователь вне каталога. */
export const MOSCOW_CENTER: Coordinates = { lat: 55.752, lon: 37.6175 };
export function isMoscowPoint(point: Coordinates) {
  return Number.isFinite(point.lat) && Number.isFinite(point.lon) && point.lat >= 55.48 && point.lat <= 55.98 && point.lon >= 37.3 && point.lon <= 37.95;
}
export function parseMapJobs(raw: string | null): MapJob[] {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    return value.filter((item): item is MapJob => {
      if (!item || !UUID.test(item.id) || typeof item.address !== "string" || item.address.length > 200 || !item.location || !isMoscowPoint(item.location) || seen.has(item.id)) return false;
      seen.add(item.id); return true;
    }).slice(0,12);
  } catch { return []; }
}
export function readMapJobs() {
  try { return parseMapJobs(localStorage.getItem(KEY)); } catch { return []; }
}
const addressKey = (address: string) => address.toLocaleLowerCase("ru").replace(/ё/g,"е").replace(/^москва[,. ]*/, "").replace(/[,.]/g," ").replace(/\s+/g," ").trim();
export function rememberMapJob(job: GenerationJob, place: {address: string; location: Coordinates} | null) {
  // Editing the address must not attach the new building to the previous map point.
  if (!place || !isMoscowPoint(place.location) || addressKey(job.address) !== addressKey(place.address)) return;
  try {
    const records = [{id:job.id,address:job.address,location:place.location},...readMapJobs().filter(item=>item.id!==job.id)].slice(0,12);
    localStorage.setItem(KEY,JSON.stringify(records));
  } catch { /* The generated story remains usable without a map bookmark. */ }
}
export function placeFromQuery(params: URLSearchParams) {
  const address = params.get("address");
  if (!address || !params.has("lat") || !params.has("lon")) return null;
  const location = {lat:Number(params.get("lat")),lon:Number(params.get("lon"))};
  return address.length <= 180 && isMoscowPoint(location) ? {address,location} : null;
}
