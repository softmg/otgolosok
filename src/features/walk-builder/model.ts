import type { Coordinates } from "../tour/types";
import { isMoscowPoint } from "../explore/map-jobs";
import { stageLabels, type GenerationStage } from "../generator/types";

export const DRAFT_KEY = "otgolosok:walk:v1";
export const MAX_WALK_STOPS = 10;
export type Place = { address: string; location: Coordinates; contentId?: string };
export type Plan = { stops: Place[]; geometry: Coordinates[]; distanceM: number; walkingMinutes: number; attribution: string };
export type StoryRef = { place: Place; id: string; stage: GenerationStage };
export type ResearchRequest = { start: Place; destination?: Place | null; mode: "loop" | "open"; minutes: 30 | 60 | 90 };
export type ResearchRef = { request: ResearchRequest; id: string | null; stops: Place[]; recoveryToken: string };
export type ResearchJob = {
  id: string; stage: GenerationStage; revision: number; request: ResearchRequest;
  phase: "discovery" | "research" | "routing" | "narration" | "complete";
  progress: { checked: number; total: number; accepted: number };
  route: Plan | null; stories: StoryRef[]; error: { code: string; message: string } | null; canRetry: boolean;
};
export type Draft = {
  version: 1; title: string; start: Place | null; destination?: Place | null; mode: "loop" | "open";
  minutes: 30 | 60 | 90; stops: Place[]; route: Plan | null;
  jobs: StoryRef[]; submitting: Place | null;
  research?: ResearchRef; researchApplied?: boolean;
};
export const emptyDraft = (): Draft => ({ version: 1, title: "Моя прогулка", start: null, mode: "loop", minutes: 30, stops: [], route: null, jobs: [], submitting: null });
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export function isPlace(v: unknown): v is Place {
  return record(v) && typeof v.address === "string" && v.address.trim().length >= 6 && v.address.length <= 180 && !/[\p{Cc}\p{Cf}<>]/u.test(v.address) && record(v.location) && typeof v.location.lat === "number" && typeof v.location.lon === "number" && isMoscowPoint(v.location as Coordinates) && (v.contentId === undefined || typeof v.contentId === "string" && /^osm:(node|way|relation):\d+$/.test(v.contentId));
}
export const placeKey = (p: Place) => `${p.address.trim().toLocaleLowerCase("ru")}|${p.location.lat}|${p.location.lon}`;
// Match normalizeAddress + the unhashed addressKey input in backend/domain.mjs.
export function storyAddressKey(address: string) {
  const normalized = address.normalize("NFKC").trim().replace(/\s+/g, " ");
  return (/москва/iu.test(normalized) ? normalized : `Москва, ${normalized}`)
    .toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
}
export function rememberStory(jobs: StoryRef[], job: StoryRef): StoryRef[] {
  return [...jobs.filter(j => j.id !== job.id), job];
}
export function validStops(start: Place | null, stops: Place[], destination?: Place | null) {
  if (!start || !isPlace(start) || stops.length < (destination ? 0 : 1) || stops.length > MAX_WALK_STOPS || !stops.every(isPlace)) return false;
  if (destination && !isPlace(destination)) return false;
  const points = [start, ...stops, ...(destination ? [destination] : [])];
  return points.every((p, i) => points.slice(0, i).every(q => {
    const rad = Math.PI / 180;
    const h = Math.sin((p.location.lat-q.location.lat)*rad/2)**2 + Math.cos(p.location.lat*rad)*Math.cos(q.location.lat*rad)*Math.sin((p.location.lon-q.location.lon)*rad/2)**2;
    return 12742000 * Math.asin(Math.sqrt(Math.min(1,h))) >= 5;
  }));
}
export function isPlan(v: unknown): v is Plan {
  return record(v) && Array.isArray(v.stops) && v.stops.length >= 0 && v.stops.length <= MAX_WALK_STOPS && v.stops.every(isPlace) &&
    Array.isArray(v.geometry) && v.geometry.length >= 2 && v.geometry.length <= 12000 && v.geometry.every(p => record(p) && typeof p.lat === "number" && typeof p.lon === "number" && isMoscowPoint(p as Coordinates)) &&
    typeof v.distanceM === "number" && Number.isFinite(v.distanceM) && v.distanceM > 0 && v.distanceM <= 8100 &&
    typeof v.walkingMinutes === "number" && Number.isFinite(v.walkingMinutes) && v.walkingMinutes > 0 && v.walkingMinutes <= 90 && typeof v.attribution === "string" && v.attribution.length > 0 && v.attribution.length <= 2000;
}
export const isJobId = (id: unknown): id is string => typeof id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
export const isStage = (stage: unknown): stage is GenerationStage => typeof stage === "string" && Object.hasOwn(stageLabels, stage);
export function isResearchRequest(v: unknown): v is ResearchRequest {
  return record(v) && isPlace(v.start) && (v.destination == null || (v.mode === "open" && isPlace(v.destination))) && (v.mode === "loop" || v.mode === "open") && (v.minutes === 30 || v.minutes === 60 || v.minutes === 90);
}
// The server key deliberately excludes the address label.
export function researchKey(r: ResearchRequest) {
  return JSON.stringify([Number(r.start.location.lat.toFixed(6)), Number(r.start.location.lon.toFixed(6)), r.mode, r.minutes, ...(r.destination ? [Number(r.destination.location.lat.toFixed(6)), Number(r.destination.location.lon.toFixed(6))] : [])]);
}
export function researchLookup(r: ResearchRequest, recoveryToken: string) {
  return `/api/walk-research-jobs?${new URLSearchParams({ lat: String(Number(r.start.location.lat.toFixed(6))), lon: String(Number(r.start.location.lon.toFixed(6))), mode: r.mode, minutes: String(r.minutes), ...(r.destination ? { destinationLat: String(r.destination.location.lat), destinationLon: String(r.destination.location.lon) } : {}), recoveryToken })}`;
}
export function readResearchJob(v: unknown, expected?: ResearchRef): ResearchJob {
  if (!record(v) || !isJobId(v.id) || !isStage(v.stage) || !Number.isSafeInteger(v.revision) || Number(v.revision) < 0 || !isResearchRequest(v.request) || !["discovery", "research", "routing", "narration", "complete"].includes(String(v.phase)) || !record(v.progress) || ![v.progress.checked, v.progress.total, v.progress.accepted].every(n => Number.isInteger(n) && Number(n) >= 0 && Number(n) <= 3) || Number(v.progress.checked) > Number(v.progress.total) || Number(v.progress.accepted) > Number(v.progress.checked) || (v.route !== null && (!isPlan(v.route) || !validStops(v.request.start, v.route.stops, v.request.destination) || v.route.walkingMinutes > v.request.minutes)) || !Array.isArray(v.stories) || v.stories.length > 3 || !v.stories.every(s => record(s) && isPlace(s.place) && isJobId(s.id) && isStage(s.stage)) || (v.error !== null && (!record(v.error) || typeof v.error.code !== "string" || typeof v.error.message !== "string")) || typeof v.canRetry !== "boolean") throw new Error("Не удалось прочитать состояние исследования.");
  const job = v as ResearchJob;
  if (expected && (researchKey(job.request) !== researchKey(expected.request) || (expected.id && job.id !== expected.id))) throw new Error("Сервис вернул другое исследование.");
  return job;
}
export function researchMatches(draft: Draft, ref: ResearchRef) {
  return !!draft.start && researchKey({ start: draft.start, destination: draft.destination, mode: draft.mode, minutes: draft.minutes }) === researchKey(ref.request) && JSON.stringify(draft.stops) === JSON.stringify(ref.stops);
}
export function applyResearch(draft: Draft, job: ResearchJob): Draft {
  if (!draft.research || draft.research.id !== job.id || !researchMatches(draft, draft.research) || researchKey(job.request) !== researchKey(draft.research.request) || job.stage !== "ready" || job.phase !== "complete" || !job.route || !job.route.stops.every(p => job.stories.some(s => placeKey(s.place) === placeKey(p) && s.stage === "ready"))) throw new Error("Исследование не соответствует текущей прогулке или ещё не завершено.");
  return { ...draft, stops: job.route.stops, route: job.route, jobs: job.stories.reduce(rememberStory, draft.jobs), researchApplied: true };
}
export function parseDraft(raw: string | null): Draft {
  if (raw === null) return emptyDraft();
  const v: unknown = JSON.parse(raw);
  if (!record(v) || v.version !== 1 || typeof v.title !== "string" || v.title.length > 120 || (v.start !== null && !isPlace(v.start)) || !["loop","open"].includes(String(v.mode)) || ![30,60,90].includes(Number(v.minutes)) || typeof v.minutes !== "number" || !Array.isArray(v.stops) || v.stops.length > MAX_WALK_STOPS || !v.stops.every(isPlace) || !Array.isArray(v.jobs) || v.jobs.length > 100 || !v.jobs.every(j => record(j) && isPlace(j.place) && isJobId(j.id) && isStage(j.stage)) || (v.submitting !== null && !isPlace(v.submitting))) throw new Error("Черновик не удалось прочитать. Исходная копия не изменена.");
  if (v.destination != null && (v.mode !== "open" || !isPlace(v.destination))) throw new Error("Некорректный финиш прогулки.");
  if (v.route !== null && (!isPlan(v.route) || !validStops(v.start as Place | null, v.stops, v.destination as Place | null) || JSON.stringify(v.route.stops) !== JSON.stringify(v.stops) || v.route.walkingMinutes > v.minutes)) throw new Error("Сохранённый маршрут повреждён. Исходная копия не изменена.");
  if ((v.research !== undefined && (!record(v.research) || !isJobId(v.research.recoveryToken) || !isResearchRequest(v.research.request) || (v.research.id !== null && !isJobId(v.research.id)) || !Array.isArray(v.research.stops) || v.research.stops.length > MAX_WALK_STOPS || !v.research.stops.every(isPlace))) || (v.researchApplied !== undefined && typeof v.researchApplied !== "boolean")) throw new Error("Сохранённое исследование повреждено. Исходная копия не изменена.");
  // Older drafts could contain the same backend job for multiple map points.
  return { ...v, jobs: (v.jobs as StoryRef[]).reduce(rememberStory, []) } as Draft;
}
export function editDraft(draft: Draft, change: Partial<Pick<Draft,"start"|"destination"|"mode"|"minutes"|"stops">>): Draft {
  return { ...draft, ...change, route: null, ...(draft.researchApplied ? { researchApplied: false } : {}) };
}
export function moveStop(stops: Place[], index: number, delta: -1 | 1): Place[] {
  const next = [...stops], target = index + delta;
  if (index < 0 || index >= next.length || target < 0 || target >= next.length) return next;
  [next[index],next[target]] = [next[target],next[index]];
  return next;
}
export function saveDraft(storage: Pick<Storage,"getItem"|"setItem">, draft: Draft, previous: string | null) {
  if (storage.getItem(DRAFT_KEY) !== previous) throw new Error("Черновик изменён в другой вкладке. Обновите страницу перед продолжением; эта версия не записана.");
  const raw = JSON.stringify(draft);
  parseDraft(raw);
  storage.setItem(DRAFT_KEY,raw);
  return raw;
}
