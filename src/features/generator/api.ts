import { jobUrl } from "./offline";
import { stageLabels, type GenerationJob } from "./types";

const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export const isJobId = (value: string | null): value is string => value !== null && idPattern.test(value);

/** Reads (GET) or changes (POST with `body`) a story job; throws an Error whose message can be shown to the user. */
export async function requestJob(path: string, body?: object, signal?: AbortSignal): Promise<GenerationJob> {
  const controller = new AbortController();
  const relay = () => controller.abort();
  signal?.addEventListener("abort", relay, { once: true });
  if (signal?.aborted) relay();
  const timer = setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), 15000);
  try {
    const response = await fetch(path, { method: body ? "POST" : "GET", signal: controller.signal,
      ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
    // A proxy error page is HTML, not our JSON error.
    const value = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(new Error(value?.error?.message ?? "Сервис пока недоступен. Попробуйте позже."), { status: response.status });
    if (!value || !isJobId(value.id) || !(value.stage in stageLabels)) throw new Error("Не удалось прочитать состояние истории.");
    return value;
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", relay); }
}

export const createStoryJob = (address: string, signal?: AbortSignal) =>
  requestJob("/api/story-jobs", { address, idempotencyKey: crypto.randomUUID() }, signal);
export const readStoryJob = (id: string, signal?: AbortSignal) => requestJob(jobUrl(id), undefined, signal);
export const retryStoryJob = (job: GenerationJob, signal?: AbortSignal) =>
  requestJob(`${jobUrl(job.id)}/retry`, { revision: job.revision }, signal);
