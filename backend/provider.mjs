import { Agent, fetch as longFetch } from "undici";
import { failure } from "./domain.mjs";
import { fetchWithRetry, isTransientError } from "./retry.mjs";

export async function boundedBody(response, maximum, signal) {
  if (Number(response.headers.get("content-length")) > maximum) {
    await response.body?.cancel();
    throw failure("RESPONSE_TOO_LARGE");
  }
  if (!response.body) throw failure("EMPTY_RESPONSE");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw failure("RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}

/**
 * 429, 5xx and a rejected key mean the provider is unavailable for every job; another 4xx concerns this request only.
 * Callers pause on the first group instead of burning job attempts (see PROVIDER_OUTAGE_CODES).
 */
export function providerStatusCode(status) {
  if (status === 429) return "PROVIDER_BUSY";
  if (status === 401 || status === 403) return "PROVIDER_AUTH";
  if (status >= 500) return "PROVIDER_UNAVAILABLE";
  return "PROVIDER_REJECTED";
}
export const PROVIDER_OUTAGE_CODES = new Set(["PROVIDER_BUSY", "PROVIDER_AUTH", "PROVIDER_UNAVAILABLE", "PROVIDER_UNREACHABLE"]);

// Model and speech calls are expensive: three attempts within the caller's deadline.
const RETRY = { attempts: 3, baseMs: 1000, maxMs: 10000 };

/** A network or DNS failure is not the request's fault: report it as an unreachable provider, not a bare TypeError. */
async function providerFetch(fetchImpl, url, init, retry = RETRY) {
  try { return await fetchWithRetry(fetchImpl, url, init, retry); }
  catch (error) {
    if (init.signal?.aborted || !isTransientError(error)) throw error;
    throw Object.assign(failure("PROVIDER_UNREACHABLE"), { cause: error });
  }
}

export function unpackResponse(bytes, contentType) {
  const text = bytes.toString("utf8");
  if (!contentType.includes("text/event-stream")) return JSON.parse(text);
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]") continue;
    const event = JSON.parse(line.slice(5));
    if (event.type === "response.completed") return event.response;
    if (["error", "response.failed", "response.incomplete"].includes(event.type)) throw failure("PROVIDER_FAILED");
  }
  throw failure("PROVIDER_INCOMPLETE");
}

// Search quota is scarce (a Perplexity Pro account) and the caller has a fallback: one retry is enough.
const SEARCH_RETRY = { attempts: 2, baseMs: 1000, maxMs: 5000 };

/** URLs of a chat-completions search answer in rank order: search results, then annotations, then bare citations. */
export function searchAnswerSources(payload) {
  const sources = new Map();
  const add = (url, title = "") => { if (typeof url === "string" && url && !sources.has(url)) sources.set(url, { url, title: typeof title === "string" ? title.slice(0, 250) : "" }); };
  for (const item of Array.isArray(payload?.search_results) ? payload.search_results : []) add(item?.url, item?.title);
  for (const item of Array.isArray(payload?.choices?.[0]?.message?.annotations) ? payload.choices[0].message.annotations : []) add(item?.url_citation?.url, item?.url_citation?.title);
  for (const url of Array.isArray(payload?.citations) ? payload.citations : []) add(url);
  return [...sources.values()];
}

export function createProvider({ baseUrl, apiKey, model = "codex/gpt-5.6-sol-medium", writerModel = "codex/gpt-5.6-sol-low", ttsModel = "gpt-4o-mini-tts", voice = "marin", searchModel = null, deepResearchModel = null, fetchImpl = fetch }) {
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" || !apiKey || base.username || base.password) throw failure("PROVIDER_CONFIG");
  const endpoint = base.href.replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  /** @param {string} prompt @param {{search?: boolean, signal?: AbortSignal, timeoutMs?: number, maxTokens?: number, model?: string}} [options] */
  async function response(prompt, { search = false, signal, timeoutMs = 90000, maxTokens = 4500, model: selectedModel = model } = {}) {
    const deadline = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    const res = await providerFetch(fetchImpl,`${endpoint}/responses`, { method: "POST", headers, signal: deadline,
      body: JSON.stringify({ model: selectedModel, store: false, stream: false, input: prompt, max_output_tokens: maxTokens,
        ...(search ? { tools: [{type:"web_search"}], include:["web_search_call.action.sources"] } : {}) }) });
    if (!res.ok) { await res.body?.cancel(); throw failure(providerStatusCode(res.status)); }
    const payload = unpackResponse(await boundedBody(res, 2000000, deadline), res.headers.get("content-type") ?? "");
    if (payload.status !== "completed") throw failure("PROVIDER_INCOMPLETE");
    const parts = (payload.output ?? []).filter((item) => item.type === "message").flatMap((item) => item.content ?? []);
    const output = parts.filter((part) => part.type === "output_text").map((part) => part.text).join("\n");
    if (!output.trim()) throw failure("EMPTY_RESPONSE");
    const sources = new Map();
    const addSource = (url, title = "") => { if (typeof url === "string" && !sources.has(url)) sources.set(url,{url,title:typeof title === "string" ? title.slice(0,250) : ""}); };
    for (const item of parts.flatMap((part) => part.annotations ?? [])) addSource(item.url,item.title);
    for (const item of payload.output ?? []) {
      if (item.type !== "web_search_call") continue;
      addSource(item.action?.url,item.action?.title);
      for (const source of item.action?.sources ?? []) addSource(source.url,source.title);
    }
    if (search && !(payload.output ?? []).some((item) => item.type === "web_search_call")) throw failure("NO_SEARCH_EVIDENCE");
    return { text: output, sources: [...sources.values()], citedUrls: [...sources.keys()], usage: payload.usage ?? null, model: selectedModel };
  }
  /** @param {string} script @param {{signal?: AbortSignal, voice?: string}} [options] */
  async function speech(script, { signal, voice: selectedVoice = voice } = {}) {
    const deadline = AbortSignal.any([AbortSignal.timeout(150000), ...(signal ? [signal] : [])]);
    const res = await providerFetch(fetchImpl, `${endpoint}/audio/speech`, { method: "POST", headers, signal: deadline,
      body: JSON.stringify({model: ttsModel, voice:selectedVoice, input: script, response_format:"mp3", speed:1,
        instructions:"Read the supplied Russian text exactly, with no additions. Warm clear conversational Russian walking-tour narration, about 140 words per minute, brief pauses between paragraphs. No music or sound effects. Read dates and addresses naturally."}) });
    if (!res.ok || !res.headers.get("content-type")?.startsWith("audio/")) { await res.body?.cancel(); throw failure("TTS_FAILED"); }
    return boundedBody(res, 10000000, deadline);
  }
  /**
   * Source discovery through a search model (Perplexity via the gateway). Only chat completions carry its citations;
   * the answer text is not returned: callers fetch the pages themselves and never trust the model's quotes.
   * @param {string} prompt @param {{signal?: AbortSignal, timeoutMs?: number}} [options]
   */
  async function searchSources(prompt, { signal, timeoutMs = 120000 } = {}) {
    return searchWithModel(searchModel,prompt,{signal,timeoutMs});
  }
  /** @param {string} prompt @param {{signal?: AbortSignal, timeoutMs?: number}} [options] */
  async function deepResearchSources(prompt, { signal, timeoutMs = 600000 } = {}) {
    return searchWithModel(deepResearchModel,prompt,{signal,timeoutMs,deep:true});
  }
  async function searchWithModel(selectedModel,prompt,{signal,timeoutMs,deep=false}) {
    const deadline = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    const dispatcher=deep && fetchImpl===fetch ? new Agent({headersTimeout:timeoutMs,bodyTimeout:timeoutMs}) : null;
    const request=dispatcher ? /** @type {typeof fetch} */ (/** @type {unknown} */ ((url,init)=>longFetch(url,{...init,dispatcher}))) : fetchImpl;
    try {
      const res = await providerFetch(request, `${endpoint}/chat/completions`, { method: "POST", headers, signal: deadline,
        body: JSON.stringify({ model: selectedModel, stream: false, messages: [{ role: "user", content: prompt }] }) }, SEARCH_RETRY);
      if (!res.ok) { await res.body?.cancel(); throw failure(providerStatusCode(res.status)); }
      let payload;
      try { payload = JSON.parse((await boundedBody(res, 2000000, deadline)).toString("utf8")); }
      catch (error) { if (error?.code || error?.name === "AbortError" || error?.name === "TimeoutError") throw error; throw failure("INVALID_MODEL_OUTPUT"); }
      const sources = searchAnswerSources(payload);
      if (!sources.length) throw failure("NO_SEARCH_EVIDENCE");
      return { sources, model: selectedModel };
    } finally { if(dispatcher)await dispatcher.close(); }
  }
  const searchEnabled = typeof searchModel === "string" && searchModel.trim() !== "";
  const deepEnabled=typeof deepResearchModel==="string" && deepResearchModel.trim()!=="";
  return { response, speech, model, writerModel, ttsModel, voice, deepResearchModel:deepEnabled?deepResearchModel:null,deepResearchSources:deepEnabled?deepResearchSources:null, searchModel: searchEnabled ? searchModel : null, searchSources: searchEnabled ? searchSources : null };
}
