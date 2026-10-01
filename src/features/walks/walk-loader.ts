import { validateWalkView, type WalkDocument, type WalkView } from "./model";
import { loadOfflineWalk, type OfflineWalkRef } from "./offline";

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
    const retryAfterMs = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1_000 : 0;
    // A limit that lifts later than the retry budget allows is reported at once instead of retried in vain.
    const retryable = retryableStatus(response.status) && !(response.status === 429 && retryAfterMs > 5_000);
    throw new WalkLoadError(record.error?.message ?? "Не удалось открыть прогулку.", response.status, retryable, Math.min(5_000, retryAfterMs));
  }
  return value;
}

export type LoadJsonInit = { method?: "PUT" | "DELETE"; headers?: Record<string, string> };

/**
 * payload, если задан, отправляется в JSON (по умолчанию POST); init задаёт метод PUT/DELETE и заголовки.
 * Запрос повторяется, поэтому должен быть идемпотентным.
 */
export async function loadJson<T>(url: string, signal: AbortSignal, validate: (value: unknown) => T, attempts = 3, payload?: unknown, init: LoadJsonInit = {}): Promise<T> {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 3) throw new RangeError("Количество попыток должно быть от 1 до 3.");
  let last: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const timeout = withTimeout(signal, 20_000);
    try {
      const response = await fetch(url, payload === undefined
        ? { ...(init.method ? { method: init.method } : {}), ...(init.headers ? { headers: init.headers } : {}), signal: timeout.signal, credentials: "same-origin", cache: "no-store" }
        : { method: init.method ?? "POST", headers: { ...init.headers, "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: timeout.signal, credentials: "same-origin", cache: "no-store" });
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

// Гостевая прогулка хранится только в браузере, поэтому опубликованные истории
// её остановок сервер подставляет по присланному документу.
export async function resolveLocalWalkView(document: WalkDocument, revision: number, signal: AbortSignal) {
  const base = localWalkView(document, revision);
  if (!document.stops.some(stop => stop.storyRef)) return base;
  const resolved = await loadJson("/api/story-walks/resolve", signal, (value): WalkView => {
    const view: WalkView = validateWalkView(value);
    if (view.revision !== revision || view.chapters.some((chapter, index) => chapter.id !== base.chapters[index].id)) throw new Error();
    return view;
  }, 3, { document, revision });
  return validateWalkView({ ...base, contentVersion: `local:${revision}:${resolved.contentVersion}`, chapters: resolved.chapters });
}

// Без сети прогулка всё равно открывается: остановки остаются в статусе «готовится».
export async function loadLocalWalkView(document: WalkDocument, revision: number, signal: AbortSignal) {
  try {
    return await resolveLocalWalkView(document, revision, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    return localWalkView(document, revision);
  }
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

export type LoadedWalk = { view: WalkView; offline: false } | { view: WalkView; offline: true; savedAt: string };

/**
 * Загружает прогулку из сети, а при сбое сети или сервера открывает сохранённую
 * офлайн-копию. Ответы «не найдена» и «нет доступа» копией не подменяются.
 */
export async function loadWalkWithOfflineCopy(load: (signal: AbortSignal) => Promise<WalkView>, ref: OfflineWalkRef | null, signal: AbortSignal,
  usable: (saved: WalkView) => boolean = () => true): Promise<LoadedWalk> {
  try {
    return { view: await load(signal), offline: false };
  } catch (error) {
    if (signal.aborted || !ref || error instanceof WalkLoadError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) throw error;
    const saved = await loadOfflineWalk(ref).catch(() => null);
    if (saved && usable(saved.view)) return { view: saved.view, offline: true, savedAt: saved.manifest.savedAt };
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
