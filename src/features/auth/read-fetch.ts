/** Bounded retries for read-only account requests. Mutations are never replayed here. */
export async function readFetch(path: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let retryAfter = 0;
    try {
      const response = await fetch(path, { ...init, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000) });
      if (attempt === 2 || (response.status !== 429 && response.status < 500)) return response;
      const header = response.headers.get("retry-after");
      retryAfter = header && /^\d+$/.test(header) ? Math.min(Number(header) * 1000, 5000) : 0;
      await response.body?.cancel();
    } catch (error) {
      if (attempt === 2 || init.signal?.aborted) throw error;
    }
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(init.signal?.reason); };
      const timer = setTimeout(() => { init.signal?.removeEventListener("abort", abort); resolve(); }, retryAfter || 300 * 2 ** attempt);
      init.signal?.addEventListener("abort", abort, { once: true });
      if (init.signal?.aborted) abort();
    });
  }
}
