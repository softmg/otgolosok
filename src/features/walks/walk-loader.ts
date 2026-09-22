import { validateWalkView, type WalkDocument, type WalkStory, type WalkView } from "./model";
import { loadOfflineWalk } from "./offline";
import { terminalStages, type GenerationJob } from "../generator/types";

export type WalkCard = {
  id: string;
  title: string;
  subtitle?: string;
  revision?: number;
  updatedAt?: string;
  visibility?: "private" | "shared";
  shareToken?: string | null;
  kind: "local" | "account" | "catalog";
};

export class WalkLoadError extends Error {
  constructor(message: string, public readonly status = 0, public readonly retryable = false, public readonly retryAfterMs = 0) {
    super(message);
    this.name = "WalkLoadError";
  }
}

function retryableStatus(status: number) {
  return status === 429 || status >= 500;
}

function withTimeout(signal: AbortSignal, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(new DOMException("Request timed out", "TimeoutError")); }, timeoutMs);
  return { signal: controller.signal, wasTimedOut: () => timedOut, dispose: () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); } };
}

async function readJson(response: Response) {
  const value = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const record = value && typeof value === "object" ? value as { error?: { message?: string } } : {};
    const retryAfter = response.headers.get("retry-after");
    const retryAfterMs = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter) ? Math.min(5_000, Number(retryAfter) * 1_000) : 0;
    throw new WalkLoadError(record.error?.message ?? "Не удалось открыть прогулку.", response.status, retryableStatus(response.status), retryAfterMs);
  }
  return value;
}

export async function loadJson<T>(url: string, signal: AbortSignal, validate: (value: unknown) => T, attempts = 3): Promise<T> {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 3) throw new RangeError("Количество попыток должно быть от 1 до 3.");
  let last: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const timeout = withTimeout(signal, 20_000);
    try {
      const response = await fetch(url, { signal: timeout.signal, credentials: "same-origin", cache: "no-store" });
      const value = await readJson(response);
      try {
        return validate(value);
      } catch {
        throw new WalkLoadError("Сервис вернул повреждённую прогулку.", response.status, false);
      }
    } catch (error) {
      last = error;
      const timedOut = timeout.wasTimedOut() || error instanceof DOMException && error.name === "TimeoutError";
      const retry = error instanceof WalkLoadError ? error.retryable : timedOut || !(error instanceof DOMException && error.name === "AbortError");
      if (!retry || attempt + 1 >= attempts || signal.aborted) throw error;
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); };
        const done = () => { signal.removeEventListener("abort", onAbort); resolve(); };
        const timer = setTimeout(done, Math.min(5_000, (error instanceof WalkLoadError ? error.retryAfterMs : 0) || 500 * 2 ** attempt) + Math.floor(Math.random() * 250));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    } finally {
      timeout.dispose();
    }
  }
  throw last ?? new WalkLoadError("Не удалось открыть прогулку.");
}

export function localWalkView(document: WalkDocument, revision: number): WalkView {
  return validateWalkView({
    document,
    revision,
    contentVersion: `local:${revision}`,
    chapters: document.stops.map(stop => ({
      id: stop.id,
      status: stop.storyRef ? "preparing" : "not_requested",
      story: null,
      audio: null,
    })),
  });
}

function publicJob(value: unknown): GenerationJob {
  if (!value || typeof value !== "object" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(String((value as { id?: unknown }).id)) || typeof (value as { stage?: unknown }).stage !== "string") throw new WalkLoadError("Сервис вернул повреждённую историю.");
  return value as GenerationJob;
}

function storyFromJob(job: GenerationJob): WalkStory | null {
  const story = job.story;
  const address = typeof story?.address === "string" ? story.address : job.address;
  if (!story || typeof story.title !== "string" || story.title.length > 180 || typeof address !== "string" || address.length > 180 || !Array.isArray(story.paragraphs) || !story.paragraphs.length) return null;
  const paragraphs = story.paragraphs.filter(item => typeof item.text === "string" && item.text.trim().length > 0).map(item => ({ text: item.text, factIds: Array.isArray(item.factIds) ? item.factIds.filter(id => typeof id === "string") : [] }));
  const sources = Array.isArray(story.sources) ? story.sources.filter(source => typeof source.id === "string" && typeof source.title === "string" && /^https:\/\/[^\s<>]+$/i.test(source.url)).map(source => ({ id: source.id, title: source.title, url: source.url, publisher: source.publisher })) : [];
  const sourceIds = new Set(sources.map(source => source.id));
  const facts = Array.isArray(story.facts) ? story.facts.filter(fact => typeof fact.id === "string" && typeof fact.claim === "string").map(fact => ({ id: fact.id, claim: fact.claim, sourceIds: Array.isArray(fact.sourceIds) ? fact.sourceIds.filter(id => sourceIds.has(id)) : [] })) : [];
  if (!paragraphs.length) return null;
  return {
    title: story.title,
    address,
    paragraphs,
    sources,
    facts,
  };
}

export async function loadLocalWalkView(document: WalkDocument, revision: number, signal: AbortSignal) {
  const base = localWalkView(document, revision);
  const chapters = await Promise.all(base.chapters.map(async chapter => {
    const stop = document.stops.find(item => item.id === chapter.id);
    if (stop?.storyRef?.kind !== "job") return chapter;
    try {
      const job = await loadJson(`/api/story-jobs/${encodeURIComponent(stop.storyRef.id)}`, signal, publicJob);
      const story = job.stage === "ready" ? storyFromJob(job) : null;
      const audio = story && job.audio && /^\/api\/story-audio\/[a-f0-9]{64}\.mp3$/.test(job.audio.url) && job.audio.sha256 === job.audio.url.slice(-68, -4) ? {
        url: job.audio.url, sha256: job.audio.sha256, durationSec: job.audio.durationSec,
      } : null;
      const status = story ? audio ? "ready" : "text_ready" : job.stage === "ready" ? "unavailable" : terminalStages.has(job.stage) ? job.stage === "failed" ? "failed" : job.stage : "preparing";
      return { id: chapter.id, status, story, audio };
    } catch (error) {
      if (signal.aborted) throw error;
      return chapter;
    }
  }));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(chapters)));
  const contentHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  return validateWalkView({ ...base, contentVersion: `local:${revision}:${contentHash}`, chapters });
}

export function loadCatalogWalk(id: string, signal: AbortSignal) {
  return loadJson(`/api/story-walks/${encodeURIComponent(id)}/view`, signal, value => validateWalkView(value));
}

export function loadSharedWalk(token: string, signal: AbortSignal) {
  return loadJson(`/api/story-walks/shared/${encodeURIComponent(token)}`, signal, value => validateWalkView(value));
}

export function loadAccountWalk(id: string, signal: AbortSignal) {
  return loadJson(`/api/me/walks/${encodeURIComponent(id)}/view`, signal, value => validateWalkView(value));
}

export async function loadAccountWalkWithOfflineCopy(id: string, scope: string | null, signal: AbortSignal) {
  try {
    return { view: await loadAccountWalk(id, signal), offline: false as const };
  } catch (error) {
    if (signal.aborted || !scope || error instanceof WalkLoadError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) throw error;
    const saved = await loadOfflineWalk(scope, id).catch(() => null);
    if (saved) return { view: saved.view, offline: true as const, savedAt: saved.manifest.savedAt };
    throw error;
  }
}

export function loadCatalogCards(signal: AbortSignal): Promise<WalkCard[]> {
  return loadJson("/api/story-walks", signal, value => {
    if (!value || typeof value !== "object" || !Array.isArray((value as { walks?: unknown }).walks)) throw new Error();
    return (value as { walks: Array<Record<string, unknown>> }).walks.flatMap(item => {
      if (typeof item.id !== "string" || typeof item.title !== "string") return [];
      return [{ id: item.id, title: item.title, subtitle: typeof item.subtitle === "string" ? item.subtitle : undefined, kind: "catalog" as const }];
    });
  });
}
