import test from "node:test";
import assert from "node:assert/strict";
import { createElevenLabsTts, elevenLabsApi, elevenLabsApiKeys, listElevenLabsVoices, speechChunks } from "./elevenlabs-tts.mjs";
import { loadElevenLabsTts } from "./server.mjs";

const audio = (bytes = "mp3") => new Response(bytes, { headers: { "Content-Type": "audio/mpeg" } });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Retry-After": "0" } });
const tagNarration = Object.assign(async script => `[warmly] ${script}`, { version: "tags-test" });

test("speech sends the tagged narration to eleven_v4 with the selected voice", async () => {
  const calls = [];
  const tts = createElevenLabsTts({ apiKeys: [{ apiKey: "PRIVATE_KEY" }], voice: "Bw26i86XOp3C5sMhVUnX", tagNarration, fetchImpl: async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(String(init.body)) }); return audio("first");
  } });
  assert.equal((await tts.speech("Памятник Гаазу.", { voice: "WTn2eCRCpoFAC50VD351" })).toString(), "first");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.elevenlabs.io/v1/text-to-speech/WTn2eCRCpoFAC50VD351?output_format=mp3_44100_128");
  assert.equal(calls[0].headers["xi-api-key"], "PRIVATE_KEY");
  assert.deepEqual(calls[0].body, { text: "[warmly] Памятник Гаазу.", model_id: "eleven_v4", language_code: "ru" });
  assert.equal(tts.ttsModel, "eleven_v4");
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
    const tts = createElevenLabsTts({ apiKeys: [{ apiKey: "key" }], voice: "voice1", tagNarration, fetchImpl: async () => replies.shift() });
    await assert.rejects(tts.speech("Текст."), { code }, code);
  }
  const replies = [json({}, 503), audio("recovered")];
  const tts = createElevenLabsTts({ apiKeys: [{ apiKey: "key" }], voice: "voice1", tagNarration, fetchImpl: async () => replies.shift() });
  assert.equal((await tts.speech("Текст.")).toString(), "recovered");
});

test("a narration the tagger rejects is never synthesized", async () => {
  const tts = createElevenLabsTts({ apiKeys: [{ apiKey: "key" }], voice: "voice1", fetchImpl: async () => assert.fail("no synthesis"),
    tagNarration: async () => { throw Object.assign(new Error("changed"), { code: "AUDIO_TAGS_CHANGED_TEXT" }); } });
  await assert.rejects(tts.speech("Текст."), { code: "AUDIO_TAGS_CHANGED_TEXT" });
});

test("configuration requires a key, a safe voice id and a tagger", () => {
  for (const options of [{ apiKeys: [], voice: "v1", tagNarration }, { apiKeys: [{ apiKey: "k" }, { apiKey: " " }], voice: "v1", tagNarration },
    { apiKeys: ["k"], voice: "v1", tagNarration }, { apiKeys: [{ apiKey: "k", voice: "../v2" }], voice: "v1", tagNarration },
    { apiKeys: [{ apiKey: "k" }], voice: "../v1", tagNarration }, { apiKeys: [{ apiKey: "k" }], voice: "v1" }])
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
  const tts = createElevenLabsTts({ apiKeys: [{ apiKey: "key" }], voice: "voice1", tagNarration, baseUrl: "https://proxy.example/v1", proxyToken: "proxy-secret",
    fetchImpl: async (url, init) => { urls.push({ url, redirect: init.redirect, token: init.headers["X-Proxy-Token"] }); return audio(); } });
  await tts.speech("Текст.");
  assert.deepEqual(urls, [{ url: "https://proxy.example/v1/text-to-speech/voice1?output_format=mp3_44100_128", redirect: "manual", token: "proxy-secret" }]);
  const direct = [];
  await createElevenLabsTts({ apiKeys: [{ apiKey: "key" }], voice: "voice1", tagNarration, fetchImpl: async (url, init) => { direct.push(init.headers["X-Proxy-Token"]); return audio(); } }).speech("Текст.");
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

test("keys come from ELEVENLABS_API_KEYS in order, or from the single ELEVENLABS_API_KEY", () => {
  /** @type {[Record<string, string>, {apiKey: string, voice: string | null}[]][]} */
  const cases = [
    [{ ELEVENLABS_API_KEYS: " first , second : Voice2 ,,first:Other ", ELEVENLABS_API_KEY: "old" }, [{ apiKey: "first", voice: null }, { apiKey: "second", voice: "Voice2" }]],
    [{ ELEVENLABS_API_KEYS: " ", ELEVENLABS_API_KEY: "old" }, [{ apiKey: "old", voice: null }]],
    [{ ELEVENLABS_API_KEY: "old" }, [{ apiKey: "old", voice: null }]],
    [{ ELEVENLABS_API_KEYS: "first,second:" }, [{ apiKey: "first", voice: null }, { apiKey: "second", voice: "" }]],
    [{ ELEVENLABS_API_KEYS: ",," }, []],
    [{}, []],
  ];
  for (const [env, keys] of cases) assert.deepEqual(elevenLabsApiKeys(env), keys, JSON.stringify(env));
});

test("a key of another account speaks the default voice with its own copy and skips other voices", async () => {
  const requests = [];
  const exhausted = new Set(["first"]);
  const tts = createElevenLabsTts({ apiKeys: [{ apiKey: "first" }, { apiKey: "second", voice: "CopyVoice" }], voice: "MainVoice", tagNarration,
    fetchImpl: async (url, init) => {
      const key = init.headers["xi-api-key"]; requests.push(`${key} ${new URL(url).pathname.split("/").pop()}`);
      return exhausted.has(key) ? json({ detail: { status: "quota_exceeded" } }, 401) : audio(key);
    } });
  const warn = console.warn; console.warn = () => {};
  try {
    assert.equal((await tts.speech("Текст.")).toString(), "second");
    assert.deepEqual(requests, ["first MainVoice", "second CopyVoice"]);
    // Another voice of the first account has no copy there: with the first key paused nothing can voice it.
    await assert.rejects(tts.speech("Текст.", { voice: "OtherVoice" }), { code: "TTS_QUOTA_EXCEEDED" });
    assert.equal(requests.length, 2);
  } finally { console.warn = warn; }
});

test("a key out of credits hands the request to the next one and is skipped for an hour", async () => {
  let time = 0;
  const used = [];
  const exhausted = new Set(["first"]);
  const tts = createElevenLabsTts({ apiKeys: [{ apiKey: "first" }, { apiKey: "second" }], voice: "voice1", tagNarration, now: () => time, fetchImpl: async (url, init) => {
    const key = init.headers["xi-api-key"]; used.push(key);
    return exhausted.has(key) ? json({ detail: { status: "quota_exceeded" } }, 401) : audio(key);
  } });
  const warn = console.warn; console.warn = () => {};
  try {
    assert.equal((await tts.speech("Текст.")).toString(), "second");
    assert.equal((await tts.speech("Текст.")).toString(), "second");
    assert.deepEqual(used, ["first", "second", "second"]);
    // After the pause the first key is asked again: its credits may have been topped up.
    exhausted.clear(); time = 3600001; used.length = 0;
    assert.equal((await tts.speech("Текст.")).toString(), "first");
    assert.deepEqual(used, ["first"]);
  } finally { console.warn = warn; }
});

test("all keys out of credits fail the narration; other key errors never switch keys", async () => {
  const warn = console.warn; console.warn = () => {};
  try {
    const used = [];
    const empty = createElevenLabsTts({ apiKeys: [{ apiKey: "first" }, { apiKey: "second" }], voice: "voice1", tagNarration, fetchImpl: async (url, init) => {
      used.push(init.headers["xi-api-key"]); return json({ detail: { status: "quota_exceeded" } }, 401); } });
    await assert.rejects(empty.speech("Текст."), { code: "TTS_QUOTA_EXCEEDED" });
    // Both keys are paused: the next narration fails without spending requests.
    await assert.rejects(empty.speech("Текст."), { code: "TTS_QUOTA_EXCEEDED" });
    assert.deepEqual(used, ["first", "second"]);
    /** @type {[Response, string][]} */
    const rejections = [[json({ detail: { status: "invalid_api_key" } }, 401), "TTS_AUTH"], [json({ detail: { status: "voice_not_found" } }, 400), "TTS_FAILED"]];
    for (const [reply, code] of rejections) {
      const tried = [];
      const tts = createElevenLabsTts({ apiKeys: [{ apiKey: "first" }, { apiKey: "second" }], voice: "voice1", tagNarration, fetchImpl: async (url, init) => { tried.push(init.headers["xi-api-key"]); return reply.clone(); } });
      await assert.rejects(tts.speech("Текст."), { code });
      assert.deepEqual(tried, ["first"], code);
    }
  } finally { console.warn = warn; }
});

test("startup warns by key number, never by key, when a spare key does not see its voice", async () => {
  const provider = /** @type {any} */ ({ response: async () => ({ text: "" }) });
  const warnings = [];
  const warn = console.warn; console.warn = message => warnings.push(String(message));
  try {
    const own = { "main-secret": "RuVoice1", "copy-secret": "CopyVoice1" };
    const reply = async (url, init) => {
      const key = init.headers["xi-api-key"];
      if (key === "broken-secret") return json({}, 401);
      return json({ voices: own[key] ? [{ voice_id: own[key], name: "Отголосок", labels: { language: "ru" } }] : [] });
    };
    const tts = await loadElevenLabsTts({ ELEVENLABS_API_KEYS: "main-secret,copy-secret:CopyVoice1,spare-secret,broken-secret", ELEVENLABS_VOICE_ID: "RuVoice1" }, provider, null, reply);
    assert.equal(tts.voice, "RuVoice1");
    assert.deepEqual(warnings, ["ElevenLabs key #3 does not see the voice RuVoice1", "ElevenLabs key #4: voices are unavailable (TTS_AUTH)"]);
    assert.ok(warnings.every(message => !message.includes("secret")));
    warnings.length = 0;
    assert.equal(await loadElevenLabsTts({ ELEVENLABS_API_KEYS: "main-secret,copy-secret:", ELEVENLABS_VOICE_ID: "RuVoice1" }, provider, null, reply), null);
    assert.deepEqual(warnings, ["ElevenLabs is disabled: ELEVENLABS_API_KEYS has a malformed voice id; use key:voiceId"]);
  } finally { console.warn = warn; }
});
