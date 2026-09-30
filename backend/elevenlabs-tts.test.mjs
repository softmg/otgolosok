import test from "node:test";
import assert from "node:assert/strict";
import { createElevenLabsTts, elevenLabsApi, listElevenLabsVoices, speechChunks } from "./elevenlabs-tts.mjs";
import { loadElevenLabsTts } from "./server.mjs";

const audio = (bytes = "mp3") => new Response(bytes, { headers: { "Content-Type": "audio/mpeg" } });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Retry-After": "0" } });
const tagNarration = Object.assign(async script => `[warmly] ${script}`, { version: "tags-test" });

test("speech sends the tagged narration to eleven_v3 with the selected voice", async () => {
  const calls = [];
  const tts = createElevenLabsTts({ apiKey: "PRIVATE_KEY", voice: "Bw26i86XOp3C5sMhVUnX", tagNarration, fetchImpl: async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(String(init.body)) }); return audio("first");
  } });
  assert.equal((await tts.speech("Памятник Гаазу.", { voice: "WTn2eCRCpoFAC50VD351" })).toString(), "first");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.elevenlabs.io/v1/text-to-speech/WTn2eCRCpoFAC50VD351?output_format=mp3_44100_128");
  assert.equal(calls[0].headers["xi-api-key"], "PRIVATE_KEY");
  assert.deepEqual(calls[0].body, { text: "[warmly] Памятник Гаазу.", model_id: "eleven_v3", language_code: "ru" });
  assert.equal(tts.scriptVersion, "tags-test");
});

test("long narration is split between paragraphs and sentences within the request limit", () => {
  assert.deepEqual(speechChunks("Один.\n\nДва.\n\n\nТри.", 12), ["Один.\n\nДва.", "Три."]);
  assert.deepEqual(speechChunks("Первое. Второе! Третье?", 16), ["Первое. Второе!", "Третье?"]);
  assert.throws(() => speechChunks("Слишком длинное предложение", 10), { code: "TTS_FAILED" });
  assert.throws(() => speechChunks("  \n\n "), { code: "TTS_FAILED" });
});

test("rejections are reported by cause and transient failures are retried", async () => {
  /** @type {[Response[], string][]} */
  const cases = [
    [[json({ detail: { status: "quota_exceeded" } }, 401)], "TTS_QUOTA_EXCEEDED"],
    [[json({ detail: { status: "invalid_api_key" } }, 401)], "TTS_AUTH"],
    [[json({ detail: { status: "voice_not_found" } }, 400)], "TTS_FAILED"],
    [[json({}, 429), json({}, 429), json({}, 429)], "TTS_BUSY"],
    [[json({}, 200)], "TTS_FAILED"],
    [[new Response("moved", { status: 302, headers: { Location: "https://help.elevenlabs.io/hc/en-us/articles/restricted-countries" } })], "TTS_REGION_BLOCKED"],
  ];
  for (const [replies, code] of cases) {
    const tts = createElevenLabsTts({ apiKey: "key", voice: "voice1", tagNarration, fetchImpl: async () => replies.shift() });
    await assert.rejects(tts.speech("Текст."), { code }, code);
  }
  const replies = [json({}, 503), audio("recovered")];
  const tts = createElevenLabsTts({ apiKey: "key", voice: "voice1", tagNarration, fetchImpl: async () => replies.shift() });
  assert.equal((await tts.speech("Текст.")).toString(), "recovered");
});

test("a narration the tagger rejects is never synthesized", async () => {
  const tts = createElevenLabsTts({ apiKey: "key", voice: "voice1", fetchImpl: async () => assert.fail("no synthesis"),
    tagNarration: async () => { throw Object.assign(new Error("changed"), { code: "AUDIO_TAGS_CHANGED_TEXT" }); } });
  await assert.rejects(tts.speech("Текст."), { code: "AUDIO_TAGS_CHANGED_TEXT" });
});

test("configuration requires a key, a safe voice id and a tagger", () => {
  for (const options of [{ apiKey: "", voice: "v1", tagNarration }, { apiKey: "k", voice: "../v1", tagNarration }, { apiKey: "k", voice: "v1" }])
    assert.throws(() => createElevenLabsTts(/** @type {any} */ (options)), { code: "PROVIDER_CONFIG" });
});

test("account voices put Russian ones first and skip malformed entries", async () => {
  const voices = await listElevenLabsVoices({ apiKey: "key", fetchImpl: async () => json({ voices: [
    { voice_id: "EnVoice1", name: "George - Warm Storyteller", labels: { language: "en" } },
    { voice_id: "RuVoice1", name: "Отголосок", labels: { language: "ru" } },
    { voice_id: "bad/id", name: "Broken" }, { name: "No id" },
  ] }) });
  assert.deepEqual(voices, [{ id: "RuVoice1", label: "Отголосок (ru)", language: "ru" }, { id: "EnVoice1", label: "George (en)", language: "en" }]);
});

test("startup enables ElevenLabs only with a text model and falls back to the configured voice", async () => {
  const provider = /** @type {any} */ ({ response: async () => ({ text: "" }) });
  const voicesReply = async () => json({ voices: [{ voice_id: "EnVoice1", name: "George", labels: { language: "en" } }, { voice_id: "RuVoice1", name: "Отголосок", labels: { language: "ru" } }] });
  assert.equal(await loadElevenLabsTts({}, provider, null, voicesReply), null);
  assert.equal(await loadElevenLabsTts({ ELEVENLABS_API_KEY: "key" }, null, null, voicesReply), null);
  assert.equal((await loadElevenLabsTts({ ELEVENLABS_API_KEY: "key" }, provider, null, voicesReply)).voice, "RuVoice1");
  assert.equal((await loadElevenLabsTts({ ELEVENLABS_API_KEY: "key", ELEVENLABS_VOICE_ID: "EnVoice1" }, provider, null, voicesReply)).voice, "EnVoice1");
  const offline = await loadElevenLabsTts({ ELEVENLABS_API_KEY: "key", ELEVENLABS_VOICE_ID: "Custom1" }, provider, null, async () => json({}, 401));
  assert.equal(offline.voice, "Custom1"); assert.deepEqual(offline.voices, []);
  assert.equal(await loadElevenLabsTts({ ELEVENLABS_API_KEY: "key" }, provider, null, async () => json({}, 401)), null);
});

test("a proxy base URL must be plain HTTPS and is used for every request", async () => {
  assert.equal(elevenLabsApi(undefined), "https://api.elevenlabs.io/v1");
  assert.equal(elevenLabsApi("https://elevenlabs-proxy.example/v1/"), "https://elevenlabs-proxy.example/v1");
  for (const value of ["http://proxy.example/v1", "https://user:secret@proxy.example/v1", "https://proxy.example/v1?x=1", "not a url"])
    assert.throws(() => elevenLabsApi(value), value);
  const urls = [];
  const tts = createElevenLabsTts({ apiKey: "key", voice: "voice1", tagNarration, baseUrl: "https://proxy.example/v1", proxyToken: "proxy-secret",
    fetchImpl: async (url, init) => { urls.push({ url, redirect: init.redirect, token: init.headers["X-Proxy-Token"] }); return audio(); } });
  await tts.speech("Текст.");
  assert.deepEqual(urls, [{ url: "https://proxy.example/v1/text-to-speech/voice1?output_format=mp3_44100_128", redirect: "manual", token: "proxy-secret" }]);
  const direct = [];
  await createElevenLabsTts({ apiKey: "key", voice: "voice1", tagNarration, fetchImpl: async (url, init) => { direct.push(init.headers["X-Proxy-Token"]); return audio(); } }).speech("Текст.");
  assert.deepEqual(direct, [undefined]);
});

test("startup turns ElevenLabs off when the server's country is blocked", async () => {
  const provider = /** @type {any} */ ({ response: async () => ({ text: "" }) });
  const blocked = async () => new Response("moved", { status: 302, headers: { Location: "https://help.elevenlabs.io/" } });
  assert.equal(await loadElevenLabsTts({ ELEVENLABS_API_KEY: "key", ELEVENLABS_VOICE_ID: "Voice1" }, provider, null, blocked), null);
  const seen = [];
  const proxied = await loadElevenLabsTts({ ELEVENLABS_API_KEY: "key", ELEVENLABS_VOICE_ID: "Voice1", ELEVENLABS_BASE_URL: "https://proxy.example/v1", ELEVENLABS_PROXY_TOKEN: "proxy-secret" }, provider, null,
    async (url, init) => { seen.push([url, init.headers["X-Proxy-Token"]]); return json({ voices: [] }); });
  assert.equal(proxied.voice, "Voice1"); assert.deepEqual(seen, [["https://proxy.example/v1/voices", "proxy-secret"]]);
});
