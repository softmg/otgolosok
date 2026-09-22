import { afterEach, expect, it, vi } from "vitest";
import { readFetch } from "./read-fetch";
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it("повторяет 503 и возвращает восстановленный ответ", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockResolvedValueOnce(new Response("", { status: 503 })).mockResolvedValueOnce(new Response("ok"));
  vi.stubGlobal("fetch", fetcher);
  const pending = readFetch("/api/auth/session");
  await vi.runAllTimersAsync();
  expect(await (await pending).text()).toBe("ok");
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("не повторяет отсутствие авторизации", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response("", { status: 401 }));
  vi.stubGlobal("fetch", fetcher);
  expect((await readFetch("/api/auth/session")).status).toBe(401);
  expect(fetcher).toHaveBeenCalledOnce();
});
