export class RequestError extends Error {
  constructor(message: string, public code: string, public status: number) { super(message); }
}
export class RejectedRequest extends RequestError {}
export const shouldOfferResearch = (selection: "auto" | "manual", error: unknown) => selection === "auto" && error instanceof RequestError && ["WALK_STOPS_NOT_FOUND", "WALK_NOT_FOUND"].includes(error.code);

type FetchInit = { headers?: HeadersInit; cache?: RequestCache; method?: string; body?: string };
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * Bounded retries for transient failures (network, timeout, 5xx, 429), none for other 4xx.
 * Resolves for a 2xx or a 304 (conditional requests); the body is read inside the timeout and buffered.
 */
export async function fetchWithRetry(path: string, signal: AbortSignal, init: FetchInit = {}): Promise<Response> {
  let last: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const controller = new AbortController();
    let timedOut = false;
    const relay = () => controller.abort(signal.reason);
    signal.addEventListener("abort", relay, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(new DOMException("Request timed out", "TimeoutError")); }, 20_000);
    try {
      const response = await fetch(path, { signal: controller.signal, cache: init.cache ?? "no-store",
        ...(init.method ? { method: init.method } : {}), ...(init.headers ? { headers: init.headers } : {}), ...(init.body !== undefined ? { body: init.body } : {}) });
      const text = await response.text();
      if (!response.ok && response.status !== 304) {
        let value: { error?: { message?: string; code?: string } } = {};
        try { value = JSON.parse(text) ?? {}; } catch { value = {}; }
        const ErrorType = response.status >= 400 && response.status < 500 ? RejectedRequest : RequestError;
        const retryAfter = response.headers.get("retry-after");
        const error = new ErrorType(value.error?.message ?? "Сервис недоступен. Повторите действие позже.", value.error?.code ?? "SERVICE_UNAVAILABLE", response.status);
        (error as RequestError & { retryAfterMs?: number }).retryAfterMs = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter) ? Math.min(5_000, Number(retryAfter) * 1_000) : 0;
        throw error;
      }
      return new Response(NULL_BODY_STATUSES.has(response.status) ? null : text, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      last = error;
      if (controller.signal.aborted && signal.aborted) throw signal.reason ?? error;
      // A spent personal daily quota does not recover within seconds, unlike a busy queue.
      if (error instanceof RejectedRequest && (error.status !== 429 || error.code === "QUOTA_EXCEEDED")) throw error;
      const retryable = timedOut || error instanceof RequestError && (error.status === 429 || error.status >= 500) || !(error instanceof RequestError) && !(error instanceof DOMException && error.name === "AbortError");
      if (!retryable || attempt === 2) {
        if (timedOut) throw new Error("Время ожидания истекло. Проверьте соединение.");
        throw error;
      }
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => { clearTimeout(delay); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); };
        const done = () => { signal.removeEventListener("abort", onAbort); resolve(); };
        const retryAfterMs = error instanceof RequestError ? (error as RequestError & { retryAfterMs?: number }).retryAfterMs ?? 0 : 0;
        const delay = setTimeout(done, Math.min(5_000, retryAfterMs || 500 * 2 ** attempt) + Math.floor(Math.random() * 250));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", relay);
    }
  }
  throw last ?? new Error("Сервис недоступен. Повторите действие позже.");
}

export async function request(path: string, signal: AbortSignal, body?: object): Promise<unknown> {
  const response = await fetchWithRetry(path, signal, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  return response.json().catch(() => ({}));
}
