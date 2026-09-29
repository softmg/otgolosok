import test from "node:test";
import assert from "node:assert/strict";
import { createProvider, providerStatusCode, PROVIDER_OUTAGE_CODES } from "./provider.mjs";

test("uses the requested writer model and records the actual model used",async()=>{
  const requests=[];
  const provider=createProvider({baseUrl:"https://provider.example/v1",apiKey:"test-key",fetchImpl:async(url,options)=>{
    requests.push({url,body:JSON.parse(/** @type {string} */ (options.body))});
    return new Response(JSON.stringify({status:"completed",output:[{type:"message",content:[{type:"output_text",text:'{"valid":true}'}]}]}),{headers:{"Content-Type":"application/json"}});
  }});
  const review=await provider.response("Review supplied evidence");
  const draft=await provider.response("Write from supplied facts",{model:provider.writerModel});
  assert.equal(requests[0].body.model,"codex/gpt-5.6-sol-medium");
  assert.equal(requests[1].body.model,"codex/gpt-5.6-sol-low");
  assert.equal(review.model,requests[0].body.model);
  assert.equal(draft.model,requests[1].body.model);
  assert.equal(requests[1].url,"https://provider.example/v1/responses");
  assert.equal(draft.text,'{"valid":true}');
});

test("OpenAI uses each job's selected voice without changing the shared default", async () => {
  const voices = [];
  const provider = createProvider({ baseUrl: "https://provider.example/v1", apiKey: "key", fetchImpl: async (_url, options) => {
    voices.push(JSON.parse(/** @type {string} */ (options.body)).voice);
    return new Response("mp3", { headers: { "Content-Type": "audio/mpeg" } });
  } });
  await Promise.all([provider.speech("Первый рассказ", { voice: "cedar" }), provider.speech("Второй рассказ", { voice: "nova" })]);
  await provider.speech("Рассказ с голосом по умолчанию");
  assert.deepEqual(voices, ["cedar", "nova", "marin"]);
  assert.equal(provider.voice, "marin");
});

test("provider HTTP statuses separate an outage from a rejected request", async () => {
  for (const [status, code] of [[429, "PROVIDER_BUSY"], [401, "PROVIDER_AUTH"], [403, "PROVIDER_AUTH"], [500, "PROVIDER_UNAVAILABLE"], [503, "PROVIDER_UNAVAILABLE"], [400, "PROVIDER_REJECTED"], [422, "PROVIDER_REJECTED"]]) {
    assert.equal(providerStatusCode(status), code, String(status));
  }
  for (const code of ["PROVIDER_BUSY", "PROVIDER_AUTH", "PROVIDER_UNAVAILABLE", "PROVIDER_UNREACHABLE"]) assert.ok(PROVIDER_OUTAGE_CODES.has(code), code);
  assert.equal(PROVIDER_OUTAGE_CODES.has("PROVIDER_REJECTED"), false);
  const provider = createProvider({ baseUrl: "https://provider.example/v1", apiKey: "key", fetchImpl: async () => new Response("{}", { status: 401 }) });
  await assert.rejects(provider.response("Проверка"), { code: "PROVIDER_AUTH" });
});

test("a DNS or network failure becomes PROVIDER_UNREACHABLE instead of an untyped error", async () => {
  let calls = 0;
  const provider = createProvider({ baseUrl: "https://provider.example/v1", apiKey: "key", fetchImpl: async () => {
    calls++; throw Object.assign(new TypeError("fetch failed"), { cause: { code: "EAI_AGAIN" } });
  } });
  await assert.rejects(provider.response("Проверка"), (/** @type {any} */ error) => error.code === "PROVIDER_UNREACHABLE" && error.cause?.cause?.code === "EAI_AGAIN");
  assert.equal(calls, 3);
});

test("an aborted request stays an abort, not an outage", async () => {
  const controller = new AbortController();
  const provider = createProvider({ baseUrl: "https://provider.example/v1", apiKey: "key", fetchImpl: async () => { controller.abort(); throw new DOMException("aborted", "AbortError"); } });
  await assert.rejects(provider.response("Проверка", { signal: controller.signal }), { name: "AbortError" });
});

test("speech retries a busy provider and stops at a deterministic refusal", async () => {
  const statuses = [503, 200];
  let calls = 0;
  const busy = createProvider({ baseUrl: "https://provider.example/v1", apiKey: "key", fetchImpl: async () => {
    calls++;
    const status = statuses.shift();
    return status === 200 ? new Response("mp3", { headers: { "Content-Type": "audio/mpeg" } }) : new Response("busy", { status, headers: { "Retry-After": "0" } });
  } });
  assert.equal((await busy.speech("Рассказ")).toString(), "mp3");
  assert.equal(calls, 2);
  calls = 0;
  const refused = createProvider({ baseUrl: "https://provider.example/v1", apiKey: "key", fetchImpl: async () => { calls++; return new Response("bad voice", { status: 400 }); } });
  await assert.rejects(refused.speech("Рассказ"), { code: "TTS_FAILED" });
  assert.equal(calls, 1);
});

const searchProvider = (fetchImpl, searchModel = "perplexity-web/pplx-auto") => createProvider({ baseUrl: "https://provider.example/v1", apiKey: "key", searchModel, fetchImpl });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("search sources come from chat completions in rank order, deduplicated", async () => {
  const requests = [];
  const provider = searchProvider(async (url, options) => {
    requests.push({ url, body: JSON.parse(/** @type {string} */ (options.body)) });
    return json({ choices: [{ message: { content: "ответ не используется", annotations: [
      { type: "url_citation", url_citation: { url: "https://b.example/", title: "Б" } },
      { type: "url_citation", url_citation: { url: "https://c.example/", title: "В" } }] } }],
    search_results: [{ url: "https://a.example/", title: "А" }, { url: "https://b.example/", title: "дубль" }, { title: "без адреса" }],
    citations: ["https://c.example/", "https://d.example/", 42, null] });
  });
  const result = await provider.searchSources("Найди источники");
  assert.equal(requests[0].url, "https://provider.example/v1/chat/completions");
  assert.deepEqual(requests[0].body, { model: "perplexity-web/pplx-auto", stream: false, messages: [{ role: "user", content: "Найди источники" }] });
  assert.deepEqual(result.sources, [{ url: "https://a.example/", title: "А" }, { url: "https://b.example/", title: "дубль" }, { url: "https://c.example/", title: "В" }, { url: "https://d.example/", title: "" }]);
  assert.equal(result.model, "perplexity-web/pplx-auto");
});

test("search failures map to codes; only transient statuses are retried once", async () => {
  for (const { status, code, calls } of [{ status: 401, code: "PROVIDER_AUTH", calls: 1 }, { status: 404, code: "PROVIDER_REJECTED", calls: 1 },
    { status: 429, code: "PROVIDER_BUSY", calls: 2 }, { status: 500, code: "PROVIDER_UNAVAILABLE", calls: 2 }]) {
    let made = 0;
    const provider = searchProvider(async () => { made++; return json({ error: { code: "model_not_found" } }, status); });
    await assert.rejects(provider.searchSources("Проверка"), { code }, String(status));
    assert.equal(made, calls, String(status));
  }
  await assert.rejects(searchProvider(async () => json({ choices: [{ message: { content: "нет ссылок" } }] })).searchSources("Проверка"), { code: "NO_SEARCH_EVIDENCE" });
  await assert.rejects(searchProvider(async () => new Response("<html>", { headers: { "Content-Type": "text/html" } })).searchSources("Проверка"), { code: "INVALID_MODEL_OUTPUT" });
});

test("search is disabled without a search model", () => {
  for (const searchModel of [null, "", "  "]) {
    const provider = searchProvider(async () => json({}), /** @type {any} */ (searchModel));
    assert.equal(provider.searchSources, null);
    assert.equal(provider.searchModel, null);
  }
});
