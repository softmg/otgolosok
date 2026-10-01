import { describe, expect, it, vi } from "vitest";
import { RejectedRequest, RequestError, fetchWithRetry, request } from "./request";

describe("ограниченный транспорт конструктора", () => {
  it("повторяет ограничение частоты без изменения ключа задания", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "retry-after": "0.01" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "accepted" })));
    vi.stubGlobal("fetch", fetcher);
    const body = { recoveryToken: "stable-key" };
    await expect(request("/api/walk-research-jobs", new AbortController().signal, body)).resolves.toEqual({ id: "accepted" });
    expect(fetcher.mock.calls.map(call => call[1].body)).toEqual([JSON.stringify(body), JSON.stringify(body)]);
  });
  it("повторяет временный сетевой сбой тем же запросом", async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const body = { recoveryToken: "stable-key" };
    await expect(request("/api/walk-research-jobs", new AbortController().signal, body)).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "POST", body: JSON.stringify(body) });
    expect(fetcher.mock.calls[1][1]).toMatchObject({ method: "POST", body: JSON.stringify(body) });
  });

  it("не повторяет детерминированный отказ клиента", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "BAD_REQUEST", message: "Проверьте данные" } }), { status: 400 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(request("/api/walk-research-jobs", new AbortController().signal, { recoveryToken: "stable-key" })).rejects.toBeInstanceOf(RejectedRequest);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("не повторяет исчерпанную суточную квоту и показывает сообщение сервера", async () => {
    const message = "Ваш суточный лимит новых историй исчерпан.";
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "QUOTA_EXCEEDED", message } }), { status: 429 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(request("/api/walk-research-jobs", new AbortController().signal, { recoveryToken: "stable-key" })).rejects.toMatchObject({ code: "QUOTA_EXCEEDED", message });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("пропускает 304 условного запроса без ошибки и передаёт заголовки", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 304, headers: { etag: '"a"' } }));
    vi.stubGlobal("fetch", fetcher);
    const response = await fetchWithRetry("/api/content/map-cells", new AbortController().signal, { headers: { "If-None-Match": '"a"' } });
    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe('"a"');
    expect(fetcher.mock.calls[0][1]).toMatchObject({ cache: "no-store", headers: { "If-None-Match": '"a"' } });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("повторяет 5xx и отдаёт тело успешного ответа", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 502, headers: { "retry-after": "0.01" } }))
      .mockResolvedValueOnce(new Response("{}", { status: 503, headers: { "retry-after": "0.01" } }))
      .mockResolvedValueOnce(new Response('{"cells":[]}', { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const response = await fetchWithRetry("/api/content/map-cells", new AbortController().signal);
    await expect(response.json()).resolves.toEqual({ cells: [] });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("сдаётся после трёх попыток с ошибкой сервера", async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ error: { code: "SERVICE_MAINTENANCE", message: "Обновление" } }), { status: 503, headers: { "retry-after": "0.01" } }));
    vi.stubGlobal("fetch", fetcher);
    const error = await fetchWithRetry("/api/content/map-cells", new AbortController().signal).catch(value => value);
    expect(error).toBeInstanceOf(RequestError);
    expect(error).toMatchObject({ status: 503, code: "SERVICE_MAINTENANCE" });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("не повторяет 404 и сохраняет режим кеша", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "Нет" } }), { status: 404 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(fetchWithRetry("/api/content/places/osm:node:1", new AbortController().signal, { cache: "no-cache" })).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][1]).toMatchObject({ cache: "no-cache" });
  });
});
