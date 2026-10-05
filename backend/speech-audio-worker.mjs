import { randomUUID } from "node:crypto";
import { createNarration } from "./audio.mjs";
import { failure } from "./domain.mjs";

export const ELEVENLABS_PROFILE_ID = "elevenlabs-v3";
const LEASE_MS = 600000;

/**
 * Queue profile of catalog voicing through ElevenLabs: the text is normalized once at enqueue time. The ID predates
 * Eleven v4 and is kept because stored texts and jobs refer to it. The model selects synthesis for new jobs;
 * ordinary enqueue preserves matching published audio when the configured model changes.
 */
export function elevenLabsProfile(voice, model) {
  return { engine: "elevenlabs", language: "ru", speaker: voice, model, configVersion: "1", chunking: "elevenlabs-v3", maximumPublicationDurationSec: 300 };
}

// The queued text is already normalized for speech; normalizing again would change it.
const prepared = Object.assign(async text => text, { version: "external-prepared" });

/**
 * Voices catalog texts queued for `profileId` with an in-process speech provider (a cloud API, not a TTS worker).
 * One job at a time: every attempt costs provider credits.
 * @param {{store: any, speechProvider: any, profileId: string, audioDirectory: string, narrate?: typeof createNarration,
 *   pollMs?: number, logs?: any}} options
 */
export function startSpeechAudioWorker({ store, speechProvider, profileId, audioDirectory, narrate = createNarration, pollMs = 5000, logs = null }) {
  let stopped = false, running = null;
  const controller = new AbortController(), workerId = `${profileId}-dispatcher`;
  const process = async () => {
    const claim = store.claimExternalAudio({ workerId, requestId: randomUUID(), profileIds: [profileId], leaseMs: LEASE_MS });
    if (!claim) return;
    const lease = { workerId, generation: claim.leaseGeneration, leaseToken: claim.leaseToken };
    try {
      store.heartbeatExternalAudio(claim.id, { ...lease, leaseMs: LEASE_MS, progress: { stage: "synthesis" } });
      const voiced = { ...speechProvider, voice: claim.profile.speaker ?? speechProvider.voice };
      const deliberate = claim.profile.engine === "elevenlabs" && Boolean(claim.revoiceRequestId);
      if (deliberate) {
        // Keep completed retry caches readable after a runtime-model change; a cache miss requires the original model.
        voiced.ttsModel = claim.profile.model;
        voiced.scriptVersion = "external-revoice-v1";
        if (claim.profile.model !== speechProvider.ttsModel) voiced.speech = async () => { throw failure("TTS_MODEL_MISMATCH"); };
      }
      const artifact = await narrate({ paragraphs: [{ text: claim.spokenText }] }, voiced, audioDirectory, controller.signal,
        { minDurationSec: 1, maxDurationSec: claim.profile.maximumPublicationDurationSec ?? 300, normalize: prepared,
          ...(deliberate ? { cacheNamespace: claim.cacheNamespace ?? `external-revoice:${claim.id}` } : {}) });
      store.acceptExternalAudio(claim.id, { ...lease, uploadId: `${profileId}-${claim.id}-${claim.leaseGeneration}`, uploadSha256: artifact.sha256, artifact });
    } catch (error) {
      if (stopped) return;
      const code = /^[A-Z_]{1,60}$/.test(error?.code ?? "") ? error.code : "TTS_FAILED";
      try { store.failExternalAudio(claim.id, { ...lease, failureId: randomUUID(), code, message: "Speech synthesis failed" }); }
      catch (failError) { logs?.captureException(failError, { operation: "speechAudioWorker.fail", context: { jobId: claim.id } }); }
      logs?.captureException(error, { operation: "speechAudioWorker", context: { jobId: claim.id, profileId, code } });
    }
  };
  const wake = () => {
    if (stopped || running) return;
    running = process().catch(error => logs?.captureException(error, { operation: "speechAudioWorker" })).finally(() => { running = null; });
  };
  const timer = setInterval(wake, pollMs);
  wake();
  return { wake, stop: async () => { stopped = true; clearInterval(timer); controller.abort(); await running; } };
}
