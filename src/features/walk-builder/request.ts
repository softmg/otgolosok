export class RequestError extends Error {
  constructor(message: string, public code: string, public status: number) { super(message); }
}
export class RejectedRequest extends RequestError {}
export const shouldOfferResearch = (selection: "auto" | "manual", error: unknown) => selection === "auto" && error instanceof RequestError && ["WALK_STOPS_NOT_FOUND", "WALK_NOT_FOUND"].includes(error.code);

export async function request(path: string, signal: AbortSignal, body?: object): Promise<unknown> {
  let last: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const controller = new AbortController();
    let timedOut = false;
    const relay = () => controller.abort(signal.reason);
    signal.addEventListener("abort", relay, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(new DOMException("Request timed out", "TimeoutError")); }, 20_000);
    try {
      const response = await fetch(path, { signal: controller.signal, cache: "no-store", ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) {
        const ErrorType = response.status >= 400 && response.status < 500 ? RejectedRequest : RequestError;
        const retryAfter = response.headers.get("retry-after");
        const error = new ErrorType(value.error?.message ?? "Сервис недоступен. Повторите действие позже.", value.error?.code ?? "SERVICE_UNAVAILABLE", response.status);
        (error as RequestError & { retryAfterMs?: number }).retryAfterMs = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter) ? Math.min(5_000, Number(retryAfter) * 1_000) : 0;
        throw error;
      }
      return value;
    } catch (error) {
      last = error;
      if (controller.signal.aborted && signal.aborted) throw signal.reason ?? error;
      if (error instanceof RejectedRequest && error.status !== 429) throw error;
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
