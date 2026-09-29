import { randomUUID } from "node:crypto";
import { createNarration } from "./audio.mjs";

export const ELEVENLABS_PROFILE_ID = "elevenlabs-v3";
const LEASE_MS = 600000;

/** Queue profile of catalog voicing through ElevenLabs: the text is normalized once at enqueue time. */
export function elevenLabsProfile(voice) {
  return { engine: "elevenlabs", language: "ru", speaker: voice, configVersion: "1", chunking: "elevenlabs-v3", maximumPublicationDurationSec: 300 };
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
      const artifact = await narrate({ paragraphs: [{ text: claim.spokenText }] }, voiced, audioDirectory, controller.signal,
        { minDurationSec: 1, maxDurationSec: claim.profile.maximumPublicationDurationSec ?? 300, normalize: prepared });
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
