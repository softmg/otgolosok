import { failure } from "./domain.mjs";
import { boundedBody } from "./provider.mjs";
import { fetchWithRetry, isTransientError } from "./retry.mjs";
import { validVoiceId } from "./tts-voices.mjs";

// https://elevenlabs.io/docs/api-reference/text-to-speech/convert
const API = "https://api.elevenlabs.io/v1";
export const ELEVENLABS_MODEL = "eleven_v3";
// Eleven v3 accepts up to 5,000 characters per request; a margin keeps tags and long paragraphs inside it.
const MAX_REQUEST_CHARS = 3000;
const RETRY = { attempts: 3, baseMs: 1000, maxMs: 10000 };

/** Paragraphs grouped into requests; an oversized paragraph is split between sentences. */
export function speechChunks(script, limit = MAX_REQUEST_CHARS) {
  const pieces = script.split(/\n\s*\n/).map(part => part.trim()).filter(Boolean).flatMap(paragraph => {
    if (paragraph.length <= limit) return [paragraph];
    const parts = [];
    let current = "";
    for (const sentence of paragraph.match(/[^.!?…]+(?:[.!?…]+["»)]*\s*|$)/g) ?? []) {
      if (sentence.length > limit) throw failure("TTS_FAILED");
      if (current && current.length + sentence.length > limit) { parts.push(current.trim()); current = ""; }
      current += sentence;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
  });
  const chunks = [];
  for (const piece of pieces) {
    const last = chunks.length - 1;
    if (last >= 0 && chunks[last].length + piece.length + 2 <= limit) chunks[last] += `\n\n${piece}`;
    else chunks.push(piece);
  }
  if (!chunks.length) throw failure("TTS_FAILED");
  return chunks;
}

/** A rejected key or an exhausted quota concerns every job: report them apart from a failure of this text. */
async function rejection(response) {
  let status = "";
  try { status = String(JSON.parse((await boundedBody(response, 20000)).toString("utf8"))?.detail?.status ?? ""); }
  catch { /* The body is diagnostic only. */ }
  if (status === "quota_exceeded") return failure("TTS_QUOTA_EXCEEDED");
  if (response.status === 401 || response.status === 403) return failure("TTS_AUTH");
  if (response.status === 429) return failure("TTS_BUSY");
  return failure("TTS_FAILED");
}

async function request(fetchImpl, url, init) {
  try { return await fetchWithRetry(fetchImpl, url, init, RETRY); }
  catch (error) {
    if (init.signal?.aborted || !isTransientError(error)) throw error;
    throw Object.assign(failure("TTS_UNREACHABLE"), { cause: error });
  }
}

/**
 * Voices of the account (requires the "Voices: Read" key permission), Russian ones first.
 * @param {{apiKey: string, fetchImpl?: typeof fetch, signal?: AbortSignal}} options
 * @returns {Promise<{id: string, label: string, language: string | null}[]>}
 */
export async function listElevenLabsVoices({ apiKey, fetchImpl = fetch, signal }) {
  const deadline = AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]);
  const response = await request(fetchImpl, `${API}/voices`, { headers: { "xi-api-key": apiKey }, signal: deadline, redirect: "error" });
  if (!response.ok) throw await rejection(response);
  let payload;
  try { payload = JSON.parse((await boundedBody(response, 2000000, deadline)).toString("utf8")); }
  catch (error) { if (error?.code) throw error; throw failure("TTS_FAILED"); }
  const voices = (Array.isArray(payload?.voices) ? payload.voices : []).flatMap(voice => {
    if (!validVoiceId(voice?.voice_id) || typeof voice.name !== "string") return [];
    const language = typeof voice.labels?.language === "string" ? voice.labels.language : null;
    const name = voice.name.split(" - ")[0].trim().slice(0, 60) || voice.voice_id;
    return [{ id: voice.voice_id, label: language ? `${name} (${language})` : name, language }];
  });
  return voices.sort((a, b) => Number(b.language === "ru") - Number(a.language === "ru"));
}

/**
 * Speech through ElevenLabs v3. The narration first gets audio tags ([warmly], [short pause]…) from `tagNarration`.
 * @param {{apiKey: string, voice: string, tagNarration: ((script: string, options: {signal?: AbortSignal}) => Promise<string>) & {version?: string},
 *   voices?: {id: string, label: string}[], model?: string, fetchImpl?: typeof fetch}} options
 */
export function createElevenLabsTts({ apiKey, voice, tagNarration, voices = [], model = ELEVENLABS_MODEL, fetchImpl = fetch }) {
  if (typeof apiKey !== "string" || !apiKey.trim() || !validVoiceId(voice) || typeof tagNarration !== "function") throw failure("PROVIDER_CONFIG");
  /** @param {string} script @param {{signal?: AbortSignal, voice?: string}} [options] */
  async function speech(script, { signal, voice: selectedVoice = voice } = {}) {
    if (!validVoiceId(selectedVoice)) throw failure("TTS_FAILED");
    const deadline = AbortSignal.any([AbortSignal.timeout(300000), ...(signal ? [signal] : [])]);
    const tagged = await tagNarration(script, { signal: deadline });
    const audio = [];
    let size = 0;
    for (const text of speechChunks(tagged)) {
      const response = await request(fetchImpl, `${API}/text-to-speech/${selectedVoice}?output_format=mp3_44100_128`, {
        method: "POST", redirect: "error", signal: deadline,
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: model, language_code: "ru" }),
      });
      if (!response.ok) throw await rejection(response);
      if (!response.headers.get("content-type")?.startsWith("audio/")) { await response.body?.cancel(); throw failure("TTS_FAILED"); }
      const bytes = await boundedBody(response, 15000000, deadline);
      size += bytes.length;
      if (size > 30000000) throw failure("RESPONSE_TOO_LARGE");
      audio.push(bytes);
    }
    return Buffer.concat(audio);
  }
  return { speech, ttsProvider: "elevenlabs", ttsModel: model, voice, voices, scriptVersion: tagNarration.version ?? "custom" };
}
