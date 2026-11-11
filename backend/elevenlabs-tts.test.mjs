import test from "node:test";
import assert from "node:assert/strict";
import { brotliCompressSync } from "node:zlib";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
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
  assert.equal(tts.ttsLanguage, "ru");
  assert.equal(tts.scriptVersion, "tags-test");
});

test("speech enforces Chinese language_code and keeps tagged CJK text intact", async () => {
  const calls = [];
  const tagged = "[warmly]这里是特列季亚科夫画廊。[short pause]“请看这里！”";
  const tts = createElevenLabsTts({ apiKeys: [{ apiKey: "key" }], voice: "Otgolosok2", language: "zh",
    tagNarration: async (script, options) => { calls.push({ script, tagLanguage: options.language }); return tagged; },
    fetchImpl: async (_url, init) => { calls.push(JSON.parse(String(init.body))); return audio(); } });
  await tts.speech("这里是特列季亚科夫画廊。“请看这里！”");
  assert.equal(tts.ttsLanguage, "zh");
  assert.deepEqual(calls, [
    { script: "这里是特列季亚科夫画廊。“请看这里！”", tagLanguage: "zh" },
    { text: tagged, model_id: "eleven_v4", language_code: "zh" },
  ]);
});

test("speech can override the configured language for one English narration", async () => {
  const seen = [];
  const tts = createElevenLabsTts({ apiKeys: [{ apiKey: "key" }], voice: "Otgolosok2",
    tagNarration: async (script, options) => { seen.push([script, options.language]); return `[warmly] ${script}`; },
    fetchImpl: async (_url, init) => { seen.push(JSON.parse(String(init.body))); return audio(); } });
  await tts.speech("This is the Tretyakov Gallery.", { language: "en" });
  assert.deepEqual(seen, [
    ["This is the Tretyakov Gallery.", "en"],
    { text: "[warmly] This is the Tretyakov Gallery.", model_id: "eleven_v4", language_code: "en" },
  ]);
  assert.equal(tts.ttsLanguage, "ru", "a per-call override does not mutate the provider default");
});

test("long narration is split between paragraphs and sentences within the request limit", () => {
  assert.deepEqual(speechChunks("Один.\n\nДва.\n\n\nТри.", 12), ["Один.\n\nДва.", "Три."]);
  assert.deepEqual(speechChunks("Первое. Второе! Третье?", 16), ["Первое. Второе!", "Третье?"]);
  assert.deepEqual(speechChunks("第一句。第二句！第三句？", 8), ["第一句。第二句！", "第三句？"]);
  assert.deepEqual(speechChunks("“第一句。”第二句！", 6), ["“第一句。”", "第二句！"]);
  assert.deepEqual(speechChunks(`${"甲".repeat(2999)}。`), [`${"甲".repeat(2999)}。`]);
  assert.throws(() => speechChunks(`${"甲".repeat(3000)}。`), { code: "TTS_FAILED" });
  assert.throws(() => speechChunks(`Коротко.\n\n${"。".repeat(11)}`, 10), { code: "TTS_FAILED" });
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
  assert.throws(() => createElevenLabsTts({ apiKeys: [{ apiKey: "k" }], voice: "v1", tagNarration, language: /** @type {any} */ ("fr") }), { code: "TTS_LANGUAGE_UNSUPPORTED" });
});

test("unsupported speech language fails before tagging or synthesis", async () => {
  let tags = 0, requests = 0;
  const tts = createElevenLabsTts({ apiKeys: [{ apiKey: "key" }], voice: "voice1",
    tagNarration: async () => { tags++; return "[warmly] Text."; }, fetchImpl: async () => { requests++; return audio(); } });
  await assert.rejects(tts.speech("Text.", { language: /** @type {any} */ ("fr") }), { code: "TTS_LANGUAGE_UNSUPPORTED" });
  assert.equal(tags, 0);
  assert.equal(requests, 0);
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

test("speech refuses every model except eleven_v4", async () => {
  const provider = /** @type {any} */ ({ response: async () => ({ text: "" }) });
  const voicesReply = async () => json({ voices: [{ voice_id: "RuVoice1", name: "Отголосок", labels: { language: "ru" } }] });
  for (const model of ["eleven_v3", "eleven_multilingual_v2", "ELEVEN_V4"]) {
    assert.throws(() => createElevenLabsTts({ apiKeys: [{ apiKey: "key" }], voice: "voice1", tagNarration, model }), { code: "PROVIDER_CONFIG" }, model);
    assert.equal(await loadElevenLabsTts({ ELEVENLABS_API_KEY: "key", ELEVENLABS_MODEL: model }, provider, null, voicesReply), null, model);
  }
  for (const model of ["eleven_v4", " eleven_v4 ", "", undefined])
    assert.equal((await loadElevenLabsTts({ ELEVENLABS_API_KEY: "key", ELEVENLABS_MODEL: model }, provider, null, voicesReply)).ttsModel, "eleven_v4", String(model));
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

test("the first active key uses its mapped copy after the original account is retired", async () => {
  for (const firstExhausted of [false, true]) {
    const requests = [];
    const tts = createElevenLabsTts({
      apiKeys: [{ apiKey: "first", voice: "FirstCopy" }, { apiKey: "second", voice: "SecondCopy" }],
      voice: "OriginalVoice", tagNarration,
      fetchImpl: async (url, init) => {
        const key = init.headers["xi-api-key"];
        requests.push([key, new URL(url).pathname.split("/").pop()]);
        return firstExhausted && key === "first" ? json({ detail: { status: "quota_exceeded" } }, 401) : audio(key);
      },
    });
    const warn = console.warn; console.warn = () => {};
    try {
      assert.equal(tts.voice, "OriginalVoice");
      assert.equal((await tts.speech("Текст.")).toString(), firstExhausted ? "second" : "first");
      assert.deepEqual(requests, firstExhausted
        ? [["first", "FirstCopy"], ["second", "SecondCopy"]]
        : [["first", "FirstCopy"]]);
    } finally { console.warn = warn; }
  }
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

test("default ElevenLabs transport decodes Brotli voices and preserves audio headers independently of global fetch", async t => {
  const previous = getGlobalDispatcher(), agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  t.after(async () => { setGlobalDispatcher(previous); await agent.close(); });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected process-global fetch"); });
  const endpoint = "https://elevenlabs-fixture.invalid", pool = agent.get(endpoint);
  const voices = { voices: [{ voice_id: "FixtureVoice1", name: "Отголосок2", labels: { language: "ru" } }] };
  const compressed = brotliCompressSync(Buffer.from(JSON.stringify(voices)));
  for (let index = 0; index < 2; index++) pool.intercept({ path: "/v1/voices", method: "GET" })
    .reply(200, compressed, { headers: { "Content-Type": "application/json", "Content-Encoding": "br" } });
  pool.intercept({ path: "/v1/text-to-speech/FixtureVoice1?output_format=mp3_44100_128", method: "POST" })
    .reply(200, Buffer.from("fixture-audio"), { headers: { "Content-Type": "audio/mpeg" } });
  const listed = await listElevenLabsVoices({ apiKey: "fixture-key", baseUrl: endpoint + "/v1" });
  assert.deepEqual(listed, [{ id: "FixtureVoice1", label: "Отголосок2 (ru)", language: "ru" }]);
  const loaded = await loadElevenLabsTts({ ELEVENLABS_API_KEY: "fixture-key", ELEVENLABS_BASE_URL: endpoint + "/v1" }, /** @type {any} */ ({ response: async () => ({ text: "" }) }), null);
  assert.equal(loaded?.voice, "FixtureVoice1");
  assert.deepEqual(loaded?.voices, listed);
  const tts = createElevenLabsTts({ apiKeys: [{ apiKey: "fixture-key" }], voice: "FixtureVoice1", tagNarration, baseUrl: endpoint + "/v1" });
  assert.equal((await tts.speech("Тестовая запись.")).toString(), "fixture-audio");
  agent.assertNoPendingInterceptors();
});
